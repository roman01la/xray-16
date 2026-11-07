# Browser survival multiplayer ownership and integration contract

## Current delivery scope

Implement reusable multiplayer infrastructure before concrete game mechanics:
stable identities and sessions, durable authoritative state, atomic/idempotent
actions, generic replication/presentation interfaces and operational recovery.
Existing combat and NPC fixtures validate those boundaries. Their fixed weapon,
loadout, spawn, safe-zone and corpse rules are provisional test configuration,
not final design requirements. Detailed survival mechanics await user specification.

## Mode boundary

Single player keeps its existing local X-Ray server, ALife, Lua gameplay, saves
and WebGPU launch path. It imports no multiplayer modules. Multiplayer uses a
separate launch/build/staging path and must refuse a single-player engine artifact.
An engine adapter capability check must succeed before multiplayer can start a
level. Starting a single-player save and merely overlaying remote actors is not
an acceptable implementation of server authority.

The synthetic network harness does not boot the game. The separately staged
engine preview loads Zaton and renders authoritative proxies using WebGPU.
`PLAN.md` records the acceptance gates and implementation status.

## Ownership

| State | Rust server | Browser and engine |
|---|---|---|
| Identity and entity lifecycle | Assign session entity IDs; spawn/remove authoritative entities | Map network IDs to presentation objects; clear map on session change |
| Player movement | Simulate inputs; collision and speed validation | Collect input; predict locally once shared rules exist; reconcile to server |
| Remote movement | Publish authoritative state | Interpolate snapshots; never advance remote gameplay authority |
| Combat and death | Weapons, fire cadence, validated shots, damage, death, respawn | Submit intent; render animation, muzzle effects, sound and confirmed results |
| Inventory and economy | Persistent ownership and atomic transactions | Request actions and display authoritative contents |
| NPCs and world events | AI, navigation, combat, spawning and survival rules | Present state; disable local gameplay AI for network-owned objects |
| Safe zones | Determine membership and enforce every applicable action | Display zone state; presentation is never enforcement |
| Rendering and audio | No ownership | Existing WebGPU and audio implementations remain client-local |

## Compatibility

`misc/web/multiplayer/contract.json` is the shared baseline contract, embedded by
Rust and loaded by the browser. Signaling requires exact agreement on schema,
binary wire version, mode, authority, world ID, content revision, coordinate
convention and tick rates. The response and reliable welcome repeat the contract.
Incompatible sessions fail before allocating a peer or exposing player state.

The default server identifies `synthetic-flat-v1`. Setting
`ZONE_COLLISION_MANIFEST` enables `zaton-static-v1`, validates both geometry and
materials and derives a capsule-supported spawn. Its content revision binds
both SHA-256 hashes and `capsule-motor-v4`; the engine checks the actual loaded
bytes before exposing actors. Cosmetic asset substitutions are independent.
Coordinates are metres with Y up. X/Z and yaw must be mapped explicitly against
X-Ray's movement and camera conventions during the actor integration; no implicit
axis conversions belong in transport serialization.

Entity IDs are u32 and unique only within a server process. They are not account
IDs or database keys. Each browser-to-engine connection has a fresh epoch and a
fresh MessageChannel. An epoch cannot be reused across reconnects. Clear all
presentation objects, pending inputs and actions on disconnect or epoch change.
With `ZONE_DATABASE`, a hashed browser credential maps to a durable principal ID.
That ID is private session metadata and is distinct from the transient network
entity ID. Simultaneous connections for one principal are rejected. The database
worker is separate from the simulation; versioned test-record mutations commit
with their replay result before acknowledging. This is development identity and
storage infrastructure, not persistent movement, inventory or account recovery.
See README for the credential lifecycle and explicit remaining limits.

## Browser and engine worker interface

WebRTC remains on the browser main thread. `BrowserEngineBridge` sends complete
snapshots through a dedicated MessagePort to `EngineBridgeEndpoint` in the engine
worker. The worker validates the contract before accepting a session.

Snapshots have one in-flight frame and one replaceable latest frame. Credit is
returned only when the engine consumes the frame, so a stopped worker cannot
accumulate an unbounded event queue. The engine consumes at its frame boundary
once the corresponding level is ready, then updates presentation objects.
Transform membership uses acknowledged complete baselines; dropped additions
or removals repeat until acknowledged. Rich model/equipment metadata will use
the reliable channel separately, without letting cross-channel ordering
override a newer complete transform frame.

Inputs use the same bounded latest-value mechanism. The main-thread client sends
at the negotiated rate; render frames do not determine server elapsed time.
Actions use bounded request/result correlation. Disconnect rejects unresolved
requests as outcome unknown; inventory must later add durable idempotency keys.
The bridge does not call C++ from a WebRTC callback or mutate engine objects from
the browser main thread.

## Storage and build separation

`storage.mjs` derives a new `fsgame.multiplayer.ltx` alongside the existing game
configuration, preserving immutable asset aliases. It routes app-data, settings,
logs, screenshots and local save paths beneath `<game>/_multiplayer_/v1/`.
The original `fsgame.ltx` and `_appdata_/savedgames` are never opened for writing.
This is logical separation, not an OPFS permissions sandbox. The eventual engine
adapter must additionally disable local save/load commands for authoritative
multiplayer gameplay. Asset ingestion/synchronization remains an explicit
single-player preparation step until a read-only multiplayer asset path exists.

The new `web-multiplayer-release` preset enables `XRAY_WEB_MULTIPLAYER`, placing
compiled output in its own build tree and staging only engine artifacts there.
It does not invoke the single-player packager. Its capability manifest explicitly
reports `actorAdapter: false`; it is not a playable multiplayer engine yet.

A separate CMake binary directory alone was insufficient: the existing build also
uses shared `bin/wasm64/Release` and `misc/web/dist` output paths. Both artifact paths and staging are now isolated for the experimental preset. Do not overwrite the known
working single-player artifacts with experimental multiplayer output.

## Community integration map

The pinned community sources and links are in README.md. FreeMP's player
connect/spawn, owned-item and death hooks guide entity lifecycle integration.
Our current engine's relevant files are `Level_network_spawn.cpp`,
`Actor_Network.cpp`, `Level.cpp` and `ActorInput.cpp`. The new Rust protocol must
have its own adapter; it is not compatible with their existing NET_Packet format.

Zone's AOI implementation provides a reference for reliable enter/leave metadata
and spatial filtering. Its documented client-owned transforms are deliberately
not adopted. Its action replay ledger informs future persistent transactions.
Its Anomaly safe-zone coordinates are not assumed to match CoP.

## Gates before real-world gameplay

The bridge is a transport boundary; the C++ map presenter supplies render-only
actors.
Do not report two-player CoP support until two real engines render each other's
actors with independent movement, verified despawn and single-player regression.
Do not report authoritative collision, weapon validation or PvE from the synthetic
world tests. Each has its own acceptance gate in PLAN.md.

## Actor adapter implementation notes

`CLevel::cl_Process_Spawn` currently forces objects local whenever `OnServer()`
is true. The current single-player direct-connect path therefore cannot be reused
unchanged for remote presentation objects. The adapter must bypass or specialize
that ownership decision in multiplayer mode, while retaining the default behavior.
`game_sv_Single::Create` constructs ALife only when `/alife` is present, but this
alone does not establish an authoritative remote-client mode. Map-only startup,
local actor creation and object updates must be verified together before exposing
a multiplayer game entry point.

## Engine snapshot boundary and isolated preview

`misc/web/multiplayer/engine-abi.mjs` copies one complete frame into a bounded
WASM buffer at the application pthread's frame boundary. The 24-byte header is
six little-endian u32 values: magic `0x474e455a` (`ZENG`), ABI 1, server tick,
local player ID, acknowledged input sequence, entity count. Each following
36-byte record contains full-precision entity state. This is an internal ABI,
not a second network protocol. It supports at most 7,424 entities.

`src/xrGame/multiplayer/Snapshot.h` validates all records before swapping the
current registry. Invalid or stale frames cannot partially alter membership.
The C++ hook has no references to CActor, AI or ALife and does not create native
server objects. It is compiled only in the experimental build. The native
single-player target does not include this code or its OnFrame call.

`pthread-bridge.mjs` handles Emscripten's prewarmed worker pool: ports remain
idle until a worker invokes the frame hook. Exactly one worker can claim the
session. Browser networking still owns the WebRTC connection; worker messages
are bounded by the existing credit-based bridge. The current standalone harness
remains a synthetic-world test; the dedicated engine preview attaches these helpers to a real application
pthread. Its C++ registry reports accepted ticks and membership changes. The opt-in map view adds render-only proxies and negotiates the configured
synthetic or pinned Zaton world.

## Zaton map-only presenter

`MapPreview.cpp` loads static geometry, collision queries and render assets using
`IGame_Level::Load`, bypassing CLevel's native networking/AI/gameplay frame paths.
Each validated server entity maps to a SpatialBase/RenderableBase proxy, with no
CGameObject, physics, inventory, scheduler or local authority. Presentation
interpolates positions and yaw over one 15 Hz snapshot interval and selects
idle/walk animation from server velocity. The camera follows the local proxy.
Keyboard input is forwarded to Rust; loss of focus sends neutral input while
network heartbeats continue. Controller/gameplay input handlers are disabled.

Synthetic mode maps X/Z offsets to the level centre and projects visual height.
Map sessions instead verify their exact geometry/material identity and use
server XYZ without projection. These modes cannot negotiate the same contract.

Two actual engine tabs verified mutual movement and disconnect removal. Their
writable roots are `zone-engine-preview-default` and `zone-engine-preview-b`;
they share only immutable asset caches. The original single-player entry remains
separate. Crouch/jump, optional first-person camera and shared prediction are
integrated; native equipment/gameplay objects are not.

## Collision and experimental server movement

`collision.rs` imports hash-pinned original CFORM v4 data into a Parry triangle
BVH. Parsing follows `src/Common/LevelStructure.hpp`, `src/xrCDB/xr_area.cpp`
and the 16-byte `CDB::TRI` in `src/xrCDB/xrCDB.h`. Coordinates are unchanged;
no visual-preview origin offset is applied. The exporter and manifest identify
geometry independently from the existing synthetic session contract.

The dependency is pinned to Parry 0.31.1. Ray and continuous capsule queries use
its BVH and narrow phase; we do not implement a new triangle/capsule solver.
Original face ordering and packed metadata are retained for future material
filtering. Imported engine BVH caches are never deserialized.

A query mesh is not a character controller. The native reference paths
`src/xrPhysics/PHSimpleCharacterInline.h` and `PHActorCharacter.cpp` show why
flPassable and flActorObstacle need interpretation before activating movement.
Static geometry alone also omits dynamic doors/props. Response, validated
spawns, content negotiation and prediction are separate integration work.

Material filtering is now implemented: optional manifest material identity pins
`gamemtl.xr`; parsing uses stored material IDs rather than assuming record order.
Actor collision blocks `!flPassable || flActorObstacle`, rejects unknown IDs and
static references to dynamic materials, and retains an actor-face-to-original-
face mapping. Raw rays remain available independently of the filtered mesh.

`World::with_collision(Arc<CollisionMap>)` opts into the fixed-tick capsule motor.
Player state and snapshot velocity are derived from actual collision-resolved
positions. Expired inputs become neutral while gravity still advances. Query
failures leave the previous state intact and increment `movement_errors`.
The executable enables this mode only when a collision manifest is configured;
content negotiation and byte verification gate the matching browser presenter.

Spawn checks lower a full capsule from above the map onto the topmost walkable
surface; this is conservative geometry validation, not authored gameplay spawn
selection. Server configuration will need explicit validated spawn locations.
The bounded motor handles terrain, wall sliding, gravity and low steps. Small
collision-checked support-normal recovery addresses tangent contact tolerance
at terrain seams. This is experimental code: mixed scenes, corners, moving
objects, stance changes and latency/reconciliation need further validation.

## Current movement and replication implementation

The map-backed server supplies XYZ directly. The presenter never projects these
positions onto a different floor. A separate wasm32 sidecar includes the exact
Rust motor modules and builds its own material-aware BVH from already verified
engine bytes (no duplicate asset download). It predicts only the local visual
proxy, with at most eight replay steps and authoritative fallback after 350 ms.
Input history is capped at 32 commands. Crouch/jump flags and vertical motor speed
are included in snapshots so reconciliation reconstructs the motor state.

Wire v2 delta frames identify a baseline tick; only an ACK of a retained sent
frame can establish that baseline. Frames contain compact remote records,
full-precision local records, or removals. Every packet is at most 1100 bytes.
The client applies a frame atomically after receiving all chunks. Unknown
baselines request a keyframe. The server retains 16 candidate baselines and
expires its active baseline after 60 ticks; the browser caches 32 complete
frames. Presentation and the C++ bridge still receive complete memberships.

Remote samples update at 15/5/3 Hz across 25/60/100 m distance bands. New entries,
removals and health/stance changes bypass sampling delay. Samples retain their
own previous values independently of the ACK baseline, preventing old ACKs
from rolling a deferred entity backward. Local state remains full precision
and is sampled every snapshot. State payload has a per-peer 96 KiB/s token budget and 32 KiB burst. Whole
frames are deferred when budget is unavailable; UDP/SCTP overhead is measured
separately. AOI contains at most the nearest 512 entities, including self.
The reliable channel carries ordered lifecycle revisions with at most 16
upserts/removals each; backpressure defers rather than drops these updates.
Metadata has its own capped registry and cannot create or remove render
actors. Descriptors identify kind, the generic stalker model and an optional stable
persistent ID. Future equipment descriptors can extend the registry. Local
rendered-crowd and persistence evidence is recorded in PLAN.md; real WAN remains
an external acceptance gate.

## Weapon integration fixture

`Combat` retains seven server poses (current plus six 30 Hz ticks) and accepts
only a requested tick and finite yaw/pitch. The shooter eye originates from
server history; closest historical capsules compete with the static map ray.
Current and historical shooter/victim safe-zone positions are checked. A
fixed prototype weapon owns its 30 rounds, six-tick cooldown and 35 damage on
the server. Replayed control sequences are rejected at the session boundary.
Map sessions reject the older target-only melee command.

This is hitscan with conservative raw-mesh occlusion. It does not implement
penetration, projectile flight, animated bone hitboxes or dynamic cover. The native X-Ray bullet manager's segment RayQuery is
an occlusion reference, not evidence that these weapon rules match CoP.
The isolated engine offers an optional first-person camera and fire intent;
weapon art/animation/audio and inventory ownership are subsequent integration.

Reloads draw from a finite 90-round reserve after 90 server ticks and are cancelled
by death. Owner-only reliable weapon state reports ammo/reserve and the reload
completion tick. Respawn requires 90 dead ticks, validates the server-selected
spawn, preserves the input sequence watermark, removes the prior life from
rewind and creates a distinct dead presentation entity. That non-lootable body
expires after 900 ticks. Stable identity and generic persistent ownership are
separate from this fixture; these fixed loadouts are not an inventory economy.

## Durable ownership boundary

Schema v2's owned entities have stable database IDs independent of u32 transport
IDs. A trusted server provisioner creates immutable fixture payloads. Clients
can list their owned records and request a revision-checked transfer to another
existing principal. Credential-derived sender identity, current owner, revision
and recipient are validated inside the same immediate transaction as the owner
change and durable outcome. Shared request IDs cannot be reused across command
kinds. Replay lookup precedes current ownership checks; otherwise a lost success
response would incorrectly become unauthorized after the successful transfer.

Scene-bound transfers require a short-lived simulation-issued session/world
context before transactional commit. Replay precedes this check, while missing
context is a transient refusal that leaves the durable command retryable. Concrete
mechanics and multi-entity exchanges are separate work. The bounded browser outbox
persists commands/results across reloads. No client can mint these entities.

Committed ownership updates publish coalesced reliable invalidation hints to both
principals' live sessions. They never directly mutate render objects or authorize
client state. Notification lag/backpressure and reconnect force refresh; the
consumer must fetch owned state and reconcile it. Durable command acknowledgement
is a separate layer: server commit precedes the response, browser result persistence
precedes explicit consumer acknowledgement. Existing entity snapshots and render
proxies still use their original transient network IDs.

Owned-state pagination now carries a transactional principal generation (schema
v3). Changes between pages invalidate the traversal rather than mixing states.
The browser publishes only a complete replacement, retains an explicitly stale
last-good view during retry, and clears it on disconnect. It refreshes on reliable
hints and periodically. This is a private owned-record view, not AOI visibility or
permission to construct native gameplay objects. Schema v4 stores a separate
trusted presentation descriptor, validated before materialization. SceneRegistry
maps stable IDs to transient world entities. Descriptor updates retain network ID;
unpublish removes it, while republish allocates a new ID. Process restart rebuilds
the mapping. Ownership transfer never changes visibility. These fixtures do not
participate in combat until a persistent gameplay policy is defined.


## Recovery and access lifecycle

A bounded 32-job persistence thread owns SQLite; simulation ticks never execute
SQL. Runtime descriptor/auth-epoch polling runs at most once per second and fails
closed. A canonical-path OS lock prevents two simulation owners of one database.
SIGTERM/SIGINT drains HTTP work, disconnects simulation peers and flushes accepted
writes before clean exit. Online backups and restore-to-new-path are documented
in `deploy/README.md` and tested with the optimized binary.

Credential revocation and rotation atomically advance a durable authorization
epoch. Authentication returns principal plus epoch from one transaction; queued
WebRTC admission requires the simulation's current epoch. Epoch changes close all
persistent sessions conservatively. Credential checks also remain transactional
for durable mutations. A valid two-second action context authorizes at issuance;
subsequent disconnect does not cancel an already accepted durable operation.

Clients close after five seconds without a complete authoritative snapshot,
clearing history, owned views and the engine bridge even when ICE failure is slow.
Brief gaps still use bounded prediction/authority fallback. Reliable metadata
alone cannot keep a stale scene authoritative. Linux container and local browser
acceptance results belong in PLAN.md; they do not establish real-network behavior.
