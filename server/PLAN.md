# STALKER browser survival multiplayer implementation plan

## Current X-Ray migration checkpoint — 2026-11-09

The full migration goal is **not complete**. This checkpoint supersedes older progress claims in the chronological notes below. Recent work is local and has not been deployed.

| Area | Verified locally | Still required |
| --- | --- | --- |
| Actor condition | Native stepping, medicine/hit replay, SQLite result commits, authored radiation integration | Coordinated automatic ownership handoff; broader hazards, lives/travel and crash recovery |
| Native damage delivery | Real512-hit saturation, five-second stopped simulation diagnostic, condition RPC while blocked, recovery without overflow reports | Multi-player bursts, memory/backlog bounds, lifecycle/socket-loss cases, durable accepted-event recovery |
| Weapon inventory | ZAW3 revision-fenced reserve boxes; real native creation/update/removal/holster tests | Complete native action lifetime and atomic persisted ammo/weapon deltas |
| Native reload execution | Stock AK-74 Action→animation completion loaded23FMJ, retained17AP, no refill for5seconds under repeated snapshots | Production request/replay/abort lane, persisted result commit, tube/launcher/jam/ammo-switch coverage |
| Fire/projectiles | Exported native rules and native condition damage proposals | Actual CWeapon trigger/cadence/wear ownership and BulletManager flight/collision integration |
| Cutover | Explicit gates keep unfinished owners disabled | Retire duplicate Rust paths, verify paired optimized builds/recovery, publish only after required gates |

Latest reload evidence: `../mechanics-test/native-reload-action-20261109/{probe.log,result.json}`. It is an isolated engine execution test, **not** a production reload cutover. Native test shutdown still requires forced cleanup. Manual gameplay acceptance remains in [MECHANICS_TEST_PLAN.md](MECHANICS_TEST_PLAN.md).

### Native weapon action ingress — local implementation

`ZWQ1` requests now reach a bounded, retry-coalescing native ingress queue after
world admission and epoch/host-boot validation. Requests carry player life,
inventory generation, weapon identity/revision and action sequence. Reload,
abort and commit remain distinct ordered operations. Lease expiry and admission
changes clear queued inputs. Result transport has a dedicated `.weapon` Unix
socket destination; an unsuccessful nonblocking send must not retire a result.

The standalone request/replay tests cover malformed packets, old or changed
fences, premature commit, retained results, abort tombstones and duplicate retry
storms at queue capacity. Rust now binds the dedicated reply socket, validates
sender path/epoch/boot, and exposes bounded typed receive/send operations.
The production coordinator and native recovery handshake remain to be connected;
codec tests do not prove socket lifecycle behavior. `CommitNativeReload` now
atomically commits the complete magazine/ammo-box graph through the persistence
worker, checks per-section ammunition conservation, and stores an exact durable
receipt. The SQLite integration test passes new-box assignment, stale generation,
missing/minted ammo rejection, rollback after a forced final-weapon-update failure,
exact retry, altered-result rejection and replay after worker restart. It does
not yet exercise a live native result through the entire coordinator.
The opt-in native consumer (`-zone-native-weapon-actions`) now invokes stock
reload actions, freezes mirrors while unsettled, captures idle completion, and
retains results for exact retries. Commit requires a newer desired inventory
generation. Abort/commit stop the native animation and discard temporary ammo
children before authoritative reconciliation. The consumer compiles, but this
full handshake still needs runtime validation and Rust durable coordination.
The `ZWR1` result encoder/decoder now preserves magazine order, weapon condition,
mode/jam state, consumed persisted boxes and newly created native ammo boxes.
A native capture helper reads these directly from the actor inventory; it is
invoked by the opt-in consumer, not enabled in production. C++→Rust fixture and malformed
packet tests pass; native capture passes optimized-configuration syntax checking.
Runtime capture validation remains pending. No Rust production reload cutover is enabled. The prior
native reload fixture remains the evidence for actual stock reload execution.

## Earlier plan and milestone notes

Build an open-world survival mode in the STALKER world with PvP, PvE, safe zones,
persistent characters and custom survival mechanics. Target 100–200 players per
server, including crowded encounters. Rust owns WebRTC, multiplayer rules and
durable state. X-Ray owns native A-Life and is the target authority for stock
engine behavior. Browsers connect using unordered WebRTC state channels with
zero retransmits and a separate reliable control channel.

The multiplayer foundation is implemented with remaining acceptance gates below.
The next delivery target is the agreed survival mechanics in
[MECHANICS.md](MECHANICS.md): original Call of Pripyat inventory and weapons,
existing loot locations, full loss of carried items on death, storage and survival.
Existing weapon, safe-zone, death/respawn and NPC fixtures remain integration
fixtures until replaced and verified against those rules.

Mechanics step 1 is under active implementation: original configuration import,
catalog-backed equipment, binary inventory requests, durable item/death/respawn
transactions and per-life starter grants are implemented locally (schema v7).
Two real browser WebRTC clients passed inventory contention, equipment transfers,
full-loss death, reconnect, respawn and server-restart recovery on the optimized
server. Original engine UI and the remaining mechanics gates are still open;
see the [mechanics checkpoint](MECHANICS.md#implementation-checkpoint--2026-11-08).
These changes have not been deployed. The custom-domain cutover used the existing
production image and is independent of this work.

Evidence for the two-client mechanics transport test is recorded in
[`inventory-transport.png`](acceptance/inventory-transport.png),
[`inventory-restart.png`](acceptance/inventory-restart.png), and
[`inventory-transport-metrics.json`](acceptance/inventory-transport-metrics.json).
The observed persistence queue peaked at one request; no invalid messages,
queue rejections or UDP drops were recorded. This does not establish capacity
at the target population, and the transport harness does not establish native
inventory UI or original weapon behavior.

The native inventory state bridge is now verified in the optimized unified
engine: the application pthread received the six-item server starter inventory
while Zaton rendered. The same build then loaded a new single-player game;
movement and the original inventory screen worked. See
[`native-inventory-bridge.json`](acceptance/native-inventory-bridge.json) for the
artifact hash, test scope and screenshots. The native multiplayer actor/item
object binding now opens the original inventory and routes single-item Drop,
rifle equip, drag between weapon slots and return to the rucksack. Reconnecting
retained the drop. See [`native-inventory-menu.json`](acceptance/native-inventory-menu.json)
for build hashes, exact item revisions and scope. These checks still use the
synthetic server world rendered with Zaton assets; two-engine pickup/corpse,
belt/batch interactions and real-map looting remain open. The same latest
optimized build passed a single-player new-game, movement, original inventory
and story-script regression check, with saves in the single-player namespace.

## Constraints

- Preserve the existing single-player browser port, renderer, local AI, launch
  behavior and saves. One unified build serves both modes; multiplayer must be
  selected explicitly from the original main menu and use separate runtime state.
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

## Stock engine ownership

One native X-Ray host per active map can own the stock simulation for all
players on that map. Rust remains the WebRTC server and the authority for
identity, multiplayer policy and durable ownership. The browser runs stock
presentation and predicts local movement from input. The separate single-player
mode keeps its own simulation and saves.

A-Life already runs in X-Ray, including NPC thinking, navigation, attacks,
damage to NPCs, corpse creation and native corpse inventory export. The bridge
relays poses, weapons and nearby positional one-shots. For player movement,
`ZONE_NATIVE_PLAYER_MOVEMENT=1` uses the stock controller in the map host and
browser. Rust relays sequenced inputs and replicates the acknowledged results.
The Rust capsule and WASM predictor are the fallback for instances where the
native mode is disabled. The checked-in Fly configuration does not set the
native-movement flag.

The current headless player object is an A-Life target with a movement
controller. Its update, scheduler and hit paths deliberately bypass normal
player gameplay. In particular, the hit bridge accepts only NPC-origin damage,
so the host cannot yet replace Rust's armour and health rules by changing a
configuration flag. Promote that object to a server-controlled gameplay actor
and keep presentation, camera and single-player story callbacks out of its
simulation path. Keep the original local actor available for legacy Lua until
the affected scripts accept explicit player context.
[Player update and hit paths](../src/xrGame/Actor.cpp) · [Native target bridge](../src/xrGame/alife_host_targets.cpp)

The headless actor receives authoritative aim pitch, health and stamina.
The browser and host apply stock body orientation, and the host sends native
fall and impact strength to the existing Rust authorization and damage
transaction. The host equips copies of committed outfits, helmets and belt
artefacts through stock X-Ray inventory. It also equips the selected firearm
with its committed durability, upgrades, attachments, ordered magazines, fire
mode and jam state. The native actor keeps the same weapon object across ammo
and condition updates. The copies are fenced by host boot and player
incarnation, and never enter A-Life persistence.
The stock weapon and condition state machines still need a headless player
execution path. Their scalar rules can be reused independently of the game
loop and of Rust's SQLite transactions.

For native NPC hits, X-Ray evaluates the mirrored outfit and helmet through the
stock protection path. Melee, physical strikes and blasts also use the belt. It
restores the local item condition immediately and sends the proposed wear
with the equipment generation. Bullets include the actual bone, piercing
power and the stock decision about whether to add a wound. X-Ray now also supplies final health and stamina damage using the same physical-hit routine as its stock ConditionHit path. The private ZAH4 proposal carries those deltas with armour wear; Rust no longer multiplies valid native proposals by its own actor coefficients. Rust authorizes the hit and commits wear,
vitals and death together. A stale or incomplete equipment mirror uses the
current durable equipment through the Rust impact path.

The isolated Zaton dog encounter reduced the first 0.45 wound hit to
0.30 before the server's actor factors. Four native proposals matched the
durable generation and committed. The outfit wore from 1.0 to 0.946,
the respirator kept its condition, and the lethal hit committed death.

For firearm shots in native-movement sessions, Rust authorizes and charges
the shot, then sends each NPC contact's terminal trajectory segment to
X-Ray. X-Ray checks live map and object collision and applies damage at the
stock skeleton intersection if the authorized NPC is the first solid
contact. When a shell has no committed PvP hit, its single reply waits for
the NPC pellet results to arrive or expire. A confirmed hit survives a
missing pellet reply. A moving NPC can leave an authorized ray before X-Ray
resolves it. Rust keeps PvP rewind and, when native movement is active, records
the X-Ray player's animated collision form in the rewind history. Firearms
use its boxes, spheres and cylinders and the corresponding bone name. Missing
or stale geometry uses the capsule path. The engine and server compile the
same flight step, material penetration, ricochet energy, CoP bullet armour,
misfire, reload ammunition priority, satiety and movement-condition rules.

### Player combat cutover

Keep one writer for saved state. Carry engine proposals over the private
host link with host boot, map visit, player life, action ID and relevant
item or condition revisions. A committed result may be replayed. A stale
proposal cannot change a newer item or life.

| Work | Cutover gate | Current implementation |
|---|---|---|
| Stock weapon actions | Native single, burst, automatic, interrupted and tube reload actions produce the exact cartridge, condition and phase transitions. Disconnect and restart preserve one debit per accepted shot. | Equipped X-Ray weapons supply fire mode, cadence, wear, the misfire curve, magazine capacity, ammunition order and shell-by-shell reload mode. Rust checks the host, life and weapon identity, then checks the durable weapon configuration in the transaction. Missing or stale profiles use catalog rules. Rust schedules trigger and reload phases, using one profile through a timed reload, and commits the magazine and ammo transfers atomically. Ammunition selection, next-type cycling and magazine type-switch decisions now call the same routines as native magazine-fed weapons and shotguns. Shotgun open/insert/end animation transitions now also share native code. Fire interruption commits the current shell and finishes with its existing insertion animation, without a second closing animation. Native-host ownership of the complete weapon state machine and animation events is still open. |
| Stock projectile execution | Native flight resolves cover, moving bodies, pellets, penetration and ricochet. Compare hits against the accepted rewind time. Native events preserve one shot receipt and durable outcome. | The equipped X-Ray weapon and chambered cartridge supply damage, impulse, wear, speed, range, drag, pellet count, penetration and dispersion. X-Ray also supplies multiplayer gravity and ricochet energy. Rust uses the same profile for rewind tracing and the inventory transaction. Both engine and server now call the same X-Ray trajectory position and collision-velocity functions, including their distinct drag cutoffs and vertical-shot behavior. Both sides also share material pass/stop/ricochet decisions, density speed loss and magnetic penetration depletion. Rust still supplies deterministic spread samples, selects bounded trace chords and resolves rewind collisions. X-Ray checks terminal NPC contacts. Dynamic cover and delayed PvP flight remain open. |
| PvP geometry and damage | Use animated bones with safe-zone, life and stale-pose checks. Keep one transaction for the approved hit, ammunition, armour wear and death. Exercise moving targets and mixed pellet contacts. | Native collision forms feed Rust rewind when available. Rewind now calls the engine's actual skeleton ray routines for boxes, spheres and cylinders, compiled from the same sources as X-Ray, instead of Parry shape intersections. Rust still selects candidates. Nearby living NPCs now publish their animated collision forms too, bounded to 64 samples per roster frame within 100 metres of player interests. Fresh NPC shapes replace coarse model-box selection in rewind. Missing or stale player geometry uses capsules, and missing or stale NPC geometry uses model boxes before native terminal confirmation. Both sides use the stock CoP armour calculation. Rust still stages the damage, bleeding and wear transaction. |
| Player condition | Stock per-bone wounds, medicine and boosters run for each server-owned actor. Safe-zone rules and custom thirst apply to the resulting deltas. Movement and equipment changes survive reconnect, death and restart. | Rust persists wounds by bone and CoP hit type, using the same wound size and healing functions as X-Ray. Old saves retain their bleeding as a wound with an unknown location. Wound size starts from resolved damage. Continuous radiation, chemical, heat, shock and psy hits now call the same post-equipment damage routine as CEntityCondition, including protection-before-immunity order, separate condition channels and heat bone scaling. Rust still supplies catalog coefficients and owns the continuous-field schedule; native immunity booster state is not yet mirrored. Stock wound randomization and actor-specific wound scaling remain open, along with the full native condition tick, medicine and booster state machines. |
| Release verification | Build optimized native, server and browser artifacts. Check a two-player Zaton combat fixture, A-Life attacks, equipment transactions, restart fencing and single-player save/load. Keep rendered multiplayer and traversal checks in the manual plan. | Native movement remains opt-in while the full cutover and capacity gate are open. |

The optimized local Zaton fixture resolved five AK-74 shots against exported
player bones, with the last two while the victim moved. SQLite recorded one
round per shot and the fifth hit committed death. The native NPC regression
confirmed two rifle hits across five rounds, three shell replies across forty
pellet checks, and generation-checked outfit wear in the melee encounter.

The isolated Zaton WebRTC fixture fired six AK-74 rounds at a moving NPC.
X-Ray confirmed two hits on stock bones and rejected four contacts. The
durable magazine lost one round for each of the six accepted trigger inputs.
The SPAS-12 fixture sent 45 pellet checks across three shells and received
one reply per shell. One shell hit after its first three pellets missed.
The durable magazine lost exactly three shells.

The isolated Zaton firearm check used an AK-74 with mixed cartridges and a
loaded launcher. The same native object retained the correct cartridge order
as the committed revision, selected ammunition, launcher mode and jam state
changed. Switching to the PM and holstering removed the previous native copy.
The firing-rules fixture deliberately assigned different wear in the Rust
catalog. X-Ray's equipped AK-74 supplied the wear for five successive shots,
leaving condition at 0.995. The Abakan used its stock two-round selector
despite a one-round catalog setting. Holding the trigger spent exactly two
rounds and left condition at 0.9975.

The [reload rules fixture](acceptance/native-reload-rules.json) changed only
the Rust catalog. The AK-74 still stopped at 30 rounds and the SPAS-12 at
eight. The shotgun committed one shell per insert, including with the
catalog's shell-by-shell flag disabled in a run without the timing export.
The Groza loaded a grenade without touching its rifle magazine.

The [cartridge impact fixture](acceptance/native-cartridge-impact.json)
used a mixed SPAS-12 magazine and a suppressed LR300. The native weapon
supplied the distinct impact and wear settings while Rust debited each
round once. A two-player AK-74 check committed four hits and a death with
the Rust catalog's weapon and ammunition damage both set to zero.

The follow-up traced and committed four AK-74 hits from roughly eight
metres away with the Rust catalog capped at five metres. The SPAS-12
traced 15 pellets for buckshot and one for the slug. The suppressed LR300
launched at 480 m/s. The Abakan used 600 m/s for its first two rounds and
550 m/s for the third round of the same held trigger.

The dispersion fixture used an altered Rust catalog and stock X-Ray settings.
The Abakan's first two rounds used weapon spread alone and its third added
the actor's standing spread. The SPAS-12 used distinct buckshot and slug
cones, and the suppressed LR300 used its fitted suppressor coefficient.
The shots used the multiplayer bullet manager's gravity and ricochet energy.

The first configured map supplies the campaign clock to the other map hosts.
Each host supplies its own weather cycle and active effect to browsers. The
sound bridge also refreshes nearby positional loops and retires them when
their samples stop. Scripted cross-map emission and artefact state remain
separate from the clock and audiovisual feed.

Local release verification used independently started Zaton and Jupiter
hosts. Both clocks advanced at factor 10, with a sampled difference of
5.9 game seconds after synchronization. A WebRTC peer received the native
weather frame and input acknowledgement 81 after sending 85 neutral input
frames with aim pitch. Collision damage, weather effects and sound loops
remain open in the manual test plan.

Stock CoP initializes A-Life from its single-player game class. Its legacy
multiplayer game class has its own player lifecycle and packet handlers.
Reuse the engine systems inside the existing map host so player gameplay and
A-Life share the same physics world and object registry.
[Stock A-Life initialization](../src/xrGame/game_sv_single.cpp) · [Stock multiplayer class](../src/xrGame/game_sv_mp.cpp)

| Subsystem | What we can route through X-Ray | What Rust continues to decide or store |
|---|---|---|
| Player movement, collision and interactions | Finish using the stock actor for stance, stairs, ladders, jump/fall and movement restrictions. Run collisions with doors, movable objects, other actors and platforms in the same physics world. Use native rays, contact shapes and floor queries for interactive objects and hit geometry. Verify scripted water and special movement per map. [Actor movement](../src/xrGame/Actor_Movement.cpp) · [Physics objects](../src/xrGame/PhysicObject.cpp) | Input authorization and expiry, acknowledgement, prediction reconciliation, spatial interest and map routing. Keep Rust geometry needed by the fallback and by remaining independent policy queries until callers are migrated. |
| Player condition and damage | Use stock health, wounds and bleeding, stamina and carry limits, hunger, radiation, psy health, medicine and timed boosters, armour/helmet/belt protection, hit reactions and physical impulses. Materialize the actor's equipped items and apply native hit/condition results to NPC, PvP and environmental sources through one pipeline. [Actor condition](../src/xrGame/ActorCondition.cpp) · [Damage and wounds](../src/xrGame/EntityCondition.cpp) | Custom thirst/dehydration and tuning, safe-zone and combat-lock policy, saved condition, death and respawn policy. Authorize damage before native mutation, including delayed effects. Commit condition, wear and death ownership changes together when required. |
| Inventory and equipment | Use stock slot/belt compatibility, rucksack behavior, outfit restrictions, weight, item defaults and class-specific use rules. Reuse native item definitions, install upgrades through the engine, and return exact changed placements, condition and item contents. The native browser UI already displays Rust-owned items. [Inventory](../src/xrGame/Inventory.cpp) · [Upgrades](../src/xrGame/inventory_upgrade_manager.cpp) | Stable item IDs and revisions, placement/ownership transaction, private storage, contested pickup, Take All, item privacy, persistence, duplicate prevention and authorization. Translate engine handles to persistent IDs. |
| Weapon state | Run the native weapon state machine for draw/holster, fire modes, cadence, reload/unload, cartridges and ammo switching, attachments, launcher state, jams, upgrades, wear and dispersion. Export native animation phase events and confirmed shots. [Magazine weapons](../src/xrGame/WeaponMagazined.cpp) · [Launcher](../src/xrGame/WeaponMagazinedWGrenade.cpp) | Accept authorized input, bind it to the current weapon and life, and commit the exact ammo, item and attachment deltas. Keep one writer for magazine state throughout each cutover. |
| Gunfire and melee | Use the stock bullet manager for travel time, pellet spread, penetration, ricochet, materials, animated hit volumes, impact feedback and NPC/player contacts. Use the native knife strike and effects. Currently Rust traces player attacks, including those later applied as hits by X-Ray. [Bullet simulation](../src/xrGame/Level_Bullet_Manager.cpp) · [Dynamic hit handling](../src/xrGame/Level_bullet_manager_firetrace.cpp) · [Knife](../src/xrGame/WeaponKnife.cpp) | Keep shot admission, input/aim validation, bounded lag compensation and safe-zone policy. Supply timestamped queries against historical collision proxies where needed. The stock bullet manager does not supply the Rust rewind contract. |
| Thrown objects and explosions | Simulate hand and underbarrel grenades, bolts, projectile contact/fuses, spin and bounce, blast occlusion, fragments and impulses in native physics. Relay the effects and resulting contacts from the same simulation that runs the anomalies. [Grenades](../src/xrGame/Grenade.cpp) · [Throwing](../src/xrGame/Missile.cpp) · [Explosions](../src/xrGame/Explosive.cpp) | Ownership and exact consumption, accepted launch ID, delayed hit authorization tied to the original life, and policy for persistence across restarts. |
| Anomalies, artefacts and detectors | Route native field contact and damage, dormant/active transitions, bolt response, forces, lights, sounds, native artefact motion, layer changes and detector capabilities. The current Rust field implementation and detector scans use exported placements. Some spawn and emission rules live in Lua and need a shared world context. [Zones](../src/xrGame/CustomZone.cpp) · [Artefacts](../src/xrGame/Artefact.cpp) · [Detectors](../src/xrGame/CustomDetector.cpp) | Shared item ownership and replenishment policy. Send reveal state only to the eligible player. Disable the Rust producer for each field once native events own it. |
| World time, weather and events | Replicate the native game time, time factor, weather cycle and weather effects for all browsers. The multiplayer preview currently initializes the environment at noon. Use native Lua for shared events such as emissions once hosts have a common schedule and restore point. [Native time](../src/xrGame/game_sv_single.cpp) · [Preview environment](../src/xrGame/multiplayer/MapPreview.cpp) | Campaign clock coordination and recovery across independent map hosts. Publish an explicit world time and event state on join and travel. |
| NPC and player presentation | Extend the existing native stream with looping sound start/update/stop, authored slung equipment, remote player body pose, death/ragdoll and world effect cues where needed. Use local stock HUD, sound and rendering for the viewing player. [Native NPC export](../src/xrGame/alife_switch_manager.cpp) · [Browser presentation](../src/xrGame/multiplayer/MapPreview.cpp) | Interest, visibility, privacy, bandwidth budgets, delivery priority and interpolation. Give confirmed local actions and movement snapshots priority over detailed remote presentation. |
| Loot, corpses and world objects | Keep authored placements and spawn definitions, NPC equipment and corpse contents. Reuse native item/world transforms, container contact and animation, and allow reviewed stock scripts to propose loot. Use the native corpse and ragdoll for presentation. [Native corpse export](../src/xrGame/alife_host_targets.cpp) · [Authored loot import](src/loot.rs) | One owner per item, starter kits, global versus personal loot, refill and expiry, durable corpse transfer, storage privacy and quest-item policy. Persist accepted results so a restarted host cannot regenerate consumed items. |
| Travel, scripted props, and doors | Reuse native touch volumes, patrol destinations, door and elevator motion, generator/lever interaction and relevant authored conditions. Stock level changes target the local campaign context, so use those outcomes as crossing requests. [Level changer](../src/xrGame/level_changer.cpp) · [Physical objects](../src/xrGame/PhysicObject.cpp) | Independent travel, access policy, durable one-character handoff and admission, and source-map continuity for other players. Cross-map NPC migration needs its own shared ownership protocol. |
| Traders, upgrades, quests, dialogue and reputation | Reuse stock trader offers/price inputs, upgrades, dialogue graphs, faction AI and quest conditions where useful. Stock story callbacks frequently assume one `db.actor`. Multiplayer needs explicit player, group or shared-world scope before running scripts that change inventory, reputation or world state. [Trade pricing](../src/xrGame/trade2.cpp) · [Lua conditions](../res/gamedata/scripts/xr_logic.script) | Transactional vendor stock, funds, barter and progression ownership if these features enter scope. Decide which story rules the open-world game uses. |

Migrate through the existing local host boundary using batched commands and
events. Identify operations by host epoch, map visit, player life and the
relevant item revision or action ID. Rust authorizes the command and records
durable outcomes. X-Ray evaluates stock behavior and reports the resulting
changes. A durable command needs a replayable result and one commit point.
Treat the native simulation checkpoint and Rust ownership database as separate
recovery domains with a fence between them, as with the existing NPC corpse
import. A process restart must not create a second writer or apply a hit to a
new life.

Start with a native actor and item adapter. Prove a slice covering one firearm
and a bandage from intent through native simulation and durable outcome, with
one NPC and one player target. Add native projectile and field contacts before
removing the equivalent Rust paths. Move clocks, world objects and additional
presentation through the same host as their ownership is settled. Keep
single-player behavior and saves in the regression gate at every step.

The [200-proxy run](acceptance/native-alife-proxy-cadence.json) used synthetic
poses. The [200-peer run](acceptance/native-alife-webrtc-population.json) was a
40-second local network run without rendered engines. Profile the upgraded host
with active player physics, equipped items, firing, hazards and multiple NPC
encounters before claiming 100–200-player capacity. See the
[community reference notes](README.md#community-references-and-decisions) for
IX-Ray FreeMP and the four-player xrMPE campaign adaptation.


## Milestones and acceptance gates

| Milestone | Work | Acceptance gate | Status |
|---|---|---|---|
| 1. Ownership and integration contract | Define authority, identity, versioning, coordinates, mode separation, engine interface and community hook mapping | Contract documented; incompatible sessions fail closed; mode/bridge tests pass | Complete |
| 2. Two players in a CoP level | Explicit multiplayer runtime in the unified entry/build; main-thread WebRTC to engine-worker bridge; remote actor lifecycle, transforms, stance/animation and interpolation | Two browsers join Zaton, see each other move, and remove disconnected actors without affecting single player | Rendering, stance and lifecycle gates passed |
| 3. Authoritative movement | Collision export; server character movement; shared movement rules; prediction and reconciliation; terrain/stairs/crouch/jump | Movement behaves correctly under latency/loss and the server rejects impossible movement | Live map motor, shared WASM prediction and stance implemented; application delay/loss combat route passed; rendered Zaton WAN smoke passed; broad traversal/impairment gates open |
| 4. Replication performance | Acknowledged deltas; reliable lifecycle metadata; distance tiers; quantization; byte budgets and metrics | Sustained 100–200-client tests in spread/crowded scenes meet documented CPU, bandwidth and freshness budgets | Deltas, tiers, budgets and metadata implemented; persistent 200-peer spread and ten-minute crowded transfer runs passed; 25-player Zaton WAN run passed; 100–200-player WAN gate open |
| 5. PvP slice | Weapon/equipment state; server shot validation and lag compensation; damage, death, corpses, respawn and verified safe-zone geometry | Consistent combat outcomes across clients, including adversarial inputs and safe-zone boundaries | Integration fixture passed, including application delay/loss; concrete PvP/equipment mechanics deferred |
| 6. Persistence foundation; survival mechanics later | Stable identity, durable ownership, atomic mutations, replay protection and crash recovery; concrete inventory/loot/survival rules deferred | Authorized test state survives reconnect/restart; concurrent/replayed mutations cannot duplicate ownership | Stable identity, durable records and generic entity ownership/transfers implemented; bounded browser recovery, live invalidation and consistent owned-state reconciliation implemented; trusted scene materialization, live policy and rendered transfer/restart/AOI gates passed |
| 7. Operations foundation; PvE later | Access control, deployment, monitoring, backups and recovery; concrete NPC behavior deferred | Reproducible deployment, backup/restore and prolonged load/recovery gates pass | Backup/restore, graceful shutdown, credential lifecycle, Linux container recovery and local soak passed; Fly deployment, restart recovery and rendered Zaton WAN tests passed; larger/longer WAN gates open; PvE deferred |

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
| Identity/access lifecycle | Admin revoke/rotate; durable auth epoch disconnects persistent sessions; queued admissions cannot cross observed revocation | Portable save-key recovery and remote deployment policy |
| Durable recovery | Online backup/restore, ownership/replay recovery, browser outbox and coherent owned views | Fly-host database-only restore drill passed; backup schedule/retention and full restored-server boot remain |
| Operations | Bounded worker metrics, health, single-server database lock, graceful SIGTERM and configuration/runbook | Fly test server deployed; rendered Zaton WAN smoke passed; production operations remain |
| Capacity and movement | 200-peer persistent crowded soak and spread/transfer test passed; 25-route native/WASM terrain parity passed | Larger WAN populations, longer endurance and special traversal coverage |

Concrete PvP/PvE, inventory/equipment UX, loot and survival mechanics remain
deferred. Existing combat/NPC behavior and persistent actors are integration
fixtures. Dynamic doors/props, moving platforms, player collision and water
behavior are not implemented by the static capsule controller; these cannot be
claimed as covered by terrain or synthetic stair tests.

Fly.io hosts the authoritative server in Frankfurt. Public frontend deployment
and transfer of game chunks from the volume to Tigris are in progress. A real Zaton engine
passed remote actor lifecycle, movement and the integration combat cycle. A
60-second run with 24 moving peers plus one rendered engine maintained 29.998 Hz
with no stale clients or snapshot skips. A separate 90-second ICE/STUN measurement
recorded median RTT 41 ms, p95 44 ms; this was a single-client measurement, not
latency under load or input-to-screen latency. Server restart preserved identities
and durable records. The hosted frontend awaits completion of the asset upload and CDN cutover;
public browser gameplay has not yet been verified.

The latest 200-peer local test includes persistence: a ten-minute crowded run
completed 9,600 writes and 9,600 ownership transfers at 29.998 Hz. It is separate
from the earlier pre-persistence baseline and is not WAN capacity evidence.
Current tests use optimized builds. No disabled-feature control rerun is needed.
Private assets, credentials and databases remain outside version control.

### Remaining foundation acceptance, in priority order

1. **Target population over WAN:** 100 then 200 clients on Zaton, spread and
   crowded, with durable writes/transfers. Record CPU, bandwidth, fresh snapshots,
   RTT and input acknowledgement timing under load. Distinguish shared-CPU host
   limits from application limits; do not infer capacity from the 25-player run.
2. **Network and endurance:** longer runs, multiple independent client networks,
   loss/jitter/disconnection and reconnect recovery. Confirm stale actors and
   pending durable operations recover without duplication. Existing local and
   application-impairment results remain useful but do not close these gates.
3. **Movement coverage:** broaden real-map traversal around slopes, stairs,
   obstacles and stance transitions under network impairment. Dynamic doors,
   platforms, player collision and water are unimplemented capabilities whose
   required scope must be decided with mechanics; they are not covered by static
   collision tests.
4. **Deployment operations:** configure backup schedule/retention and verify a
   restore on the actual host; establish monitoring and failure recovery. Public
   frontend delivery is in progress. Portable save-key recovery replaces a broader
   account system by user decision; public browser recovery verification remains.

The foundation is ready for concrete mechanic specifications, while these
acceptance gates continue. PvE behavior, final PvP rules, inventory/equipment,
loot, survival and safe-zone rules remain intentionally deferred to those
specifications. Existing fixtures must not be presented as finished mechanics.

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


### Fly.io WAN acceptance — 2026-11-07

- Deployed optimized Rust 1.93.1 build to one Fly Machine in Frankfurt, with
  a dedicated public IPv4/UDP endpoint, HTTPS signaling, private development
  access token and encrypted persistent volume. See `deploy/FLY.md`.
- Real-network testing exposed an ICE destination mismatch behind hosting NAT:
  incoming datagrams were tagged with the private socket address, while the ICE
  host candidate was public. The single-endpoint receive path now restores the
  advertised logical destination. Browser connectivity passed after deployment.
- Initial two-peer synthetic-world test passed for 31.04 seconds at 29.994 Hz:
  five committed record writes, zero stale clients, movement errors, UDP drops,
  snapshot skips or late ticks. Raw evidence: `acceptance/fly-synthetic-2peer.json`.
- The browser is on the local laptop and the server is in Frankfurt; this is real
  WAN traffic, but not independent client networks or rendered Zaton acceptance.
  No injected packet loss/reordering. Shared two-CPU / 1-GiB sizing is not a
  200-player capacity certification. Long endurance remains open.
- User explicitly approved private collision upload after automatic review
  requested confirmation. The collision export is kept on the private volume;
  no game assets are published. Original single-player JS/WASM checksums match.
- Source validation: 56 Rust tests, 62 JavaScript tests, Clippy, proxy integration,
  and remote optimized image build pass. Local gateway keeps credentials out of
  browser code and retains paginated identity query strings.

- 25-peer synthetic WAN run passed for 61.00 seconds at 29.999 Hz, with 137
  committed writes, zero stale clients, late ticks, movement errors, UDP drops or
  snapshot skips. Sampled p95 simulation/replication: 0.010/0.845 ms; UDP output
  0.307 MiB/s. Evidence: `acceptance/fly-synthetic-25peer.json`. This exercises
  records, not ownership transfers or rendered engines.

- Graceful SIGTERM restart on Fly passed. Two clients resumed saved identities
  with minimum starting record revision 7, committed five further writes and
  maintained 29.988 Hz without stale clients or movement errors. Evidence:
  `acceptance/fly-synthetic-restart.json`.

- Zaton collision upload completed with explicit approval. Both geometry/material
  SHA-256 hashes match local exports. Only the three collision files remain in
  `/data/collision`; they are not served over HTTP. The deployed contract is
  `zaton-static-v1` / `capsule-motor-v4`; idle resident memory was 407,300 KiB.
- Optimized rendered engine connected over real WAN, verified content, enabled
  shared prediction and passed remote actor creation/removal. The existing
  integration combat fixture passed movement outside the safe zone, validated
  hits/cooldown/reload, death, immobile body, delayed safe respawn, distinct corpse,
  expiry and disconnect cleanup. Evidence: `acceptance/fly-zaton-engine.txt`.
  These validate the foundation fixture, not final gameplay mechanics.

- Final Zaton WAN run passed: 24 moving test peers plus one rendered engine,
  25 total players / 26 visible entities, 60.34 seconds at 29.998 Hz. There were
  131 committed writes, zero stale network clients, late ticks, movement errors,
  UDP drops or snapshot skips. Sampled p95 simulation/replication: 0.588/0.660 ms;
  UDP output 0.296 MiB/s. `acceptance/fly-zaton-25player.json` records the run.
- Temporary browser clients were disconnected/closed; the original single-player
  tab was preserved. The remote test server remains running with private Zaton
  collision and persistence; localhost:8090 remains its local preview gateway.
  100–200-player WAN capacity, multiple independent access networks and extended
  endurance are still unverified. No full browser frontend was publicly deployed.

- WebRTC network RTT measured over 90.41 seconds from this laptop to Fly Frankfurt:
  35 fresh selected-candidate ICE/STUN readings, median 41 ms, p95 44 ms,
  range 40–45 ms. Successive RTT absolute differences: median 1 ms, p95 3 ms.
  UDP path to 77.83.143.60:50000 stayed selected; no hidden-tab samples.
  Gameplay snapshots were active for one probe, without rendered/load peers.
  This measures network/ICE RTT, not input-to-render or input-ack latency, and
  does not establish latency under 200-player load. Raw evidence is
  `acceptance/fly-zaton-network-latency.json`; repeat using the local preview
  `engine-preview/latency-test.html`. Probe disconnected after completion.


### Public deployment and host restore checkpoint — 2026-11-07

- Public game upload is ongoing. Compressed blobs are decoded and hash-verified
  on the Fly volume, followed by server-side Tigris copy and verified CDN cutover.
  Per user direction, verified bulk chunk copies will then be deleted from the
  volume. Frontend files, release manifests, private collision and player state
  remain. Gateway tests cover republishing and upload skipping after offload.
- Fly-host online SQLite backup and isolated restore passed full dump comparison,
  integrity and foreign-key checks, schema v4. The snapshot contained 28 identities,
  zero owned entities and zero scene descriptors. The live database was not
  replaced or restarted. Evidence: `acceptance/fly-backup-restore.json`.
- This closes only the database restore check on the actual host. Scheduled
  backups/retention, restored-server boot with populated state, monitoring and
  independent disaster recovery remain open. The upload was not interrupted.
- Core multiplayer implementation is ready for mechanic development; target-scale
  WAN, endurance/recovery and broader traversal acceptance are still outstanding.


### Portable save identity — 2026-11-07

- User selected simple portable save keys instead of accounts/passwords/email.
  Existing 256-bit random browser credentials already map to stable server
  principals; the database stores credential hashes, not the raw save key.
- Added Copy save key and Open save controls. Import calls resume only, validates
  the server identity before changing local storage, shares the enrollment lock,
  disconnects the current session and reloads into the recovered save. Invalid
  keys and network failure leave the previous identity untouched. Switching does
  not delete either server-side save; keep the old key to return to it.
- The browser can copy an enrolled key from local storage with Rust stopped.
  The panel fits short viewports, releases pointer lock while open and allows
  the canvas to recapture the mouse after closing. In local Zaton, an independent
  Chrome profile recovered the same life and all seven item records, and reopened
  them after a Rust restart. The identity tests cover enrollment retries and
  unknown keys. Keep the portable key to recover from lost browser storage.
  [Save key acceptance](acceptance/multiplayer-save-key.json)


### Binary-only WebRTC control — 2026-11-07

- Wire v3 replaces JSON control messages in both directions, without legacy
  negotiation or dual-format support. Reload/respawn/leave are eight bytes,
  attack 12 and fire 20; welcome, lifecycle, weapon, ownership invalidation and
  action results use bounded binary event encoding. HTTPS APIs remain JSON.
- Rust/JS cross-codec tests cover all command/event types, invalid direction,
  versions, lengths, authority fields, nonfinite aim and truncation. All 58 Rust
  tests and 68 multiplayer JavaScript tests pass; Clippy and optimized build pass.
- Two real browser WebRTC clients passed the complete Zaton combat/reload/death/
  respawn/corpse-expiry/disconnect scenario. Two initial runs failed the final
  safe-zone assertion with `invalid_tick`; no timing data was captured then.
  Added timing diagnostics and reran: snapshot age 24.095 ms, reply 2.525 ms,
  complete scenario passed. The intermittent stale-aim cause is not established;
  the six-tick rewind limit was not widened and the assertion was not relaxed.
  Evidence: `acceptance/binary-control-v3.txt`. This was transport-only, not a
  rendered-engine or WAN test. Existing single-player code is unchanged.
- Matching server image and separate frontend are being prepared for the queued
  public deployment after upload/CDN cutover. No running upload was restarted.


### Public asset delivery completed

- Initial upload completed: 1,446 unique blobs verified and release published.
  Server-side Tigris copy verified 319 chunks / 4,733,401,387 bytes. After CDN
  routing verification, all 319 bulk volume copies were removed as requested.
- Matching binary-v3 server image is deployed. The frontend publish initially
  failed because the separately staged engine symlink lacked its parent target;
  repaired that target and published successfully. The update reused 1,438 blobs
  and uploaded nine changed blobs, 13,474 compressed bytes.
- Public root serves the latest frontend with portable save-key controls; health
  is healthy, frontend contract is wire v3, CDN chunk length and CORS match.
  Fresh-browser hosted gameplay verification remains pending.
- Agreed mechanics and implementation sequence are saved in MECHANICS.md.


### Single-player website

- Added independent `/singleplayer/` publication on the existing Fly host, sharing
  verified Tigris game chunks. Root and `/multiplayer/` retain their own release.
- Site opens the original single-player menu automatically, with full-viewport
  canvas and no launcher. Startup feedback remains until rendered frames arrive.
  Browser-local `stream-cop` saves are separate from multiplayer identity/state.
- Gateway tests verify independent publication and preservation of both entries.
  Existing local production JS/WASM checksums remain unchanged. The public build
  uses the separately staged streaming-capable single-player engine.
- Public cold launch rendered the original menu at approximately 60 FPS with zero
  WebGPU validation errors. This verifies hosted startup and asset delivery; a
  complete new-game playthrough was not repeated for the website wrapper.

### Remaining full migration sequence

The active goal is the full X-Ray migration, not just shared arithmetic. Completion still requires:

1. Native actor condition ownership: transport revision-fenced condition snapshots/proposals, restore wounds and active medicine/boosters, run stock condition updates without camera/tutorial effects, and commit results once. Preserve custom thirst and safe-zone policy. Native damage proposals now carry final health/stamina, but wound construction and periodic condition changes remain in Rust.
2. Native equipped weapon action execution: trigger/reload/animation phases must produce proposals from the actual CWeapon state machine. Persist exactly one magazine/ammo/condition change per action; avoid firing a native projectile before authorization.
3. Native projectile/world collision ownership, including moving cover and delayed PvP flight, integrated with approved rewind and durable shot receipts.
4. Remove or isolate duplicate Rust gameplay paths once the corresponding native path is complete. Keep authorization, persistence, transport, routing and custom policies in Rust.
5. Verify optimized native/server/browser builds, transaction/replay/restart fencing, and retain all unrun rendered gameplay cases in the manual checklist. The goal is not complete while a native ownership gate above remains open.

#### Native condition handoff requirements

`CActorCondition::AdvanceZoneCondition(gameSeconds)` now provides an explicit headless entry point into stock condition simulation. It suppresses local god-mode flags, camera/death effects, tutorial callbacks, booster UI, and duplicate environmental-hit generation for host-owned actors. It is deliberately not invoked by the ordinary proxy scheduler or the host movement loop yet.

Before enabling it, implement a revision-fenced request/result handoff. Each request must identify host boot, player incarnation/map visit, condition revision and step sequence; one native result can replace exactly that input revision. A dropped/stale result must not advance or overwrite a newer condition. Stop Rust's stock condition tick only after that handoff is active, retaining custom thirst and safe-zone policy. Carry effective inventory weight because the host currently materializes equipped objects rather than every rucksack object.

The ordinary game-save condition serializer is insufficient as a per-step snapshot: it omits health and max power, quantizes wounds, and loading boosters repeatedly adds their modifiers again. The new ZCS1 host checkpoint captures full-precision wounds, medicine duration, movement hysteresis, pending deltas, remaining invulnerability and all booster-derived rates/protections/carry limits. Decode validates complete lengths, bounds and floats before actor restoration. Capture/Restore replace the booster map and absolute derived values together, avoiding repeated additive application. Its bounded codec passes 1,000 exact round trips plus malformed/truncated/oversized input checks. It is not wired to requests or persistence yet. Equipment restoration uses a per-actor pulse timer (the stock static timer was shared by all actors); the timer is checkpointed too. Stock timed medicine also needs an implementation audit: this branch stores `m_curr_medicine_influence`, but no advancing path was found in its condition update. Do not silently drop existing timed treatments during the cutover.

#### Condition protocol implementation status

The native endpoint now accepts bounded ZCT1 requests from the admitted Rust socket, matching host epoch/boot, player incarnation and current equipment generation. Requests contain revision, monotonic sequence, bounded game-time step, effective carried weight and a ZCS1 input checkpoint. A zero-time request without a checkpoint returns the actor baseline. It returns ZCU1 on the private `.hits.condition` endpoint. The host restores the input, advances stock actor/equipment condition code, captures the proposal, then restores its previous state before returning. Results are cached per player: identical retries return the same bytes; older sequences or altered same-sequence requests are rejected. Cache lifetime follows the native player incarnation.

Checkpoint/protocol unit checks pass, including baseline versus real-step validation, oversized time rejection, exact retry replay and modified/stale sequence rejection. Native optimized build is in progress. Rust sending, projection/persistence commit and live request/restore verification are still required before enabling native condition ownership. No continuous native condition request is emitted yet, so the existing Rust tick remains active.

Rust condition handoff infrastructure is now implemented: `native_condition::Request` builds ZCT1 using the shared native validator, validates every ZCU1 fence field against the pending request, and rejects truncated or altered replies. `AlifeInterests` owns a private nonblocking `.hits.condition` receiver, checks sender and admitted host identity, and exposes send/drain methods. `CommitNativeCondition` persists the validated checkpoint and public condition projection atomically with the existing death transaction, checking condition revision and equipment generation. No browser command routes to this operation. Checkpoints use the shared native decoder when deserialized from SQLite.

The full Rust suite passes 171 tests. The integration test verifies stale-equipment rejection, one commit per condition revision and byte-exact checkpoint persistence. Optimized native compilation passes; the Rust release build is running. Deployment contexts include the new shared codec/protocol headers and C++ adapter. The live peer scheduler still does not send condition requests; legacy hit/medicine handling and bootstrap conversion must be routed through this handoff before disabling Rust's condition simulation.

Live native-player equipment synchronization now requests and retries an engine condition baseline. Baselines are templates only: they are not installed over saved player state. Cached/pending baselines are fenced by host boot, player incarnation and equipment generation and retired on death/travel. A shared sequence allocator covers baseline and future simulation requests. The private Unix socket fixture verifies reply delivery, delayed old-equipment rejection and incarnation retirement. Next, implement conversion of existing Rust wounds/treatments/boosters into the native baseline, then schedule and commit native steps; Rust's condition tick is still active until that conversion and mutation routing are complete.

Initial saved-state conversion is implemented as a zero-time ZCI1 request carrying bounded ZCL1 data. Rust exports exact condition values, named per-hit-type wounds, medicine effects and remaining duration, and active booster type/value/timer. Legacy scalar bleeding is retained as an unknown-bone wound. The native actor resolves named bones through its actual skeleton, rejects unknown names, removes prior booster modifiers, restores the imported state and applies each booster through stock engine functions. The proposal then follows the existing checkpoint reply/cache path and restores the host mirror afterward. Native and Rust codec regressions cover exact wound values, treatment fields, booster enum mapping, truncations and the zero-time-only import rule. Live peer scheduling/commit of this conversion and timed medicine advancement remain open; no saved condition is overwritten yet.

### Native timed medicine and headless policy isolation

The explicit host condition step now advances imported timed medicine in real seconds, matching booster timing, and applies each elapsed fraction through `CEntityCondition::ApplyInfluence`. The last fraction is clamped to the remaining duration. Standalone checks cover partial doses, exact completion, an oversized final step, exhausted treatment and invalid duration. The normal single-player scheduler is unchanged. Host-owned actors also ignore local god-mode flags in satiety and hit handling while retaining `CanBeHarmed` policy.

This does not enable live condition ownership: peer scheduling, native hit/treatment mutations, and stopping the duplicate Rust tick remain required. Manual verification once enabled: import an active treatment, reconnect mid-treatment, and confirm no duration reset or double dose; check safe-zone protection separately from local debug flags. Actor-level runtime verification remains pending.

### Native consumable proposals

ZCM1 requests carry a validated checkpoint and a bounded configuration section name, with zero elapsed time. The native actor executes the same `ApplyConsumableEffects` function now used by `CEatableItem::UseBy`: stock medicine application followed by configured boosters. Immediate deltas are resolved without ticking medicine/booster timers; timed treatments remain in the checkpoint. Host actors suppress local use sounds. Missing required section fields are rejected before mandatory engine config reads. The host captures the result and restores its mirror; existing sequence/revision/equipment fences and replay caching apply.

Standalone protocol checks pass for exact checkpoint/section decoding, missing checkpoint/section, invalid section characters, oversized names, bad lengths and nonzero elapsed time. All three targeted Rust condition tests pass, including consumable request/reply validation. The optimized native build has compiled ActorCondition, EntityCondition and eatable_item successfully; the complete link is still running. This is not yet connected to the inventory consume transaction: the remaining cutover must commit item use and the resulting checkpoint atomically, preserve custom thirst, and prevent any legacy effect application after native ownership. Manual cases remain pending: food, instant medkit, timed medkit, bandage, antirad, replacement booster, active medicine rejection semantics, retry and reconnect during consumption.

### Atomic native consumption persistence

`ConsumeNative` is an internal session-only persistence operation. It uses the existing inventory command authorization, item revision and durable request ledger, verifies the native proposal's item section and equipment generation, then writes its checkpoint and decrements one item portion in the same SQLite transaction. Condition revision changes reject the result. Stock medicine/booster effects are not applied again in Rust; configured custom hydration is applied once at consumption. Legacy consumption explicitly rejects native-owned checkpoints. Loadout generation/notification handling includes the native operation.

The integration fixture verifies wrong-generation, wrong-section and wrong-condition rejection with unchanged inventory/state, exact native health/checkpoint preservation, a single portion/revision change and identical retry results. It also injects a failure after condition update but before item debit to verify atomic rollback. Peer scheduling and native condition ownership are still not enabled, so this transaction is currently exercised by the test fixture only. Live replay/reconnect and all rendered consumption cases remain manual checks after cutover.

### Condition reply routing and current verification

The admitted native condition receiver routes replies to either the pending baseline or one pending action per actor. Baselines cannot supersede an in-flight action with a newer replay sequence. Actions retry identical bytes, completed results are delivered once, and cancellation matches the full fence so an old cancellation cannot remove newer work. Queues/results retire on host boot or actor life changes; the peer must still validate condition revision/equipment before persistence. Unknown/duplicate responses do not create results.

The private Unix-socket regression passes baseline/action interleaving, exact retry bytes, delayed baseline replies, one-shot result delivery and old-versus-current cancellation. The optimized native build completed successfully, including stock consumable refactoring and native timed medicine. All 27 equipment integration tests pass. Continuous native condition scheduling remains off pending native hit/field mutations and removal of the Rust stock tick; none of these checks claims rendered gameplay validation.

### Full native hit proposals

ZCH1 transports a checkpoint and validated physical/environmental hit (type, power, penetration, aim flag and named bone). The actor resolves its real skeleton, uses stock `CDamageManager::HitScale`, normalizes alternate knife hits like `CEntityAlive::Hit`, and executes `CActorCondition::ConditionHit` including native wound creation. Multiplayer armour rules are enabled only for this explicit proposal. The native mirror's outfit/helmet condition and last-hitter pointers are restored; no particles, impulses or sounds are emitted by proposal calculation. Safe-zone `CanBeHarmed` rejects damage effects.

ZCV1 returns the resulting checkpoint plus outfit/helmet wear, kept together by the action reply router. Rust rejects missing/invalid wear, truncated results and stale fences; it cannot accidentally accept a hit as a checkpoint-only reply. Standalone native codec and targeted Rust checks pass. Fly build-context staging includes the new header and succeeds. The optimized native rebuild is in progress (the first attempt was invalidated by a concurrent header edit and terminated; a fresh build was then started).

Still required: atomic damage/death plus wear persistence, integrating these proposals with PvP/NPC/field authorization and delayed shots, live actor hit/restore verification, and turning off duplicate Rust condition damage/ticks. These are not yet live gameplay changes. Manual cases: bullet and knife body/head hits, explosion, bleeding, radiation/psy/heat/chemical/shock, armour breakage, protected safe zone, lethal hit, repeated reply and concurrent equipment change.

### Atomic native hit persistence

`CommitNativeImpact` now validates the live condition revision and inventory generation, requires a matching outfit/helmet set, applies the proposed wear, installs the native checkpoint, and uses the existing atomic condition/death/corpse transaction. It preserves the combat deadline and refreshes loadout/appearance. Rust does not recalculate hit damage or wounds. Wear validation is shared with the earlier native armour proposal path, and all equipment is validated before any wear is written.

The equipment regression now covers a missing helmet proposal, an injected condition-write failure after armour writes (all wear rolls back), exact native checkpoint/vitals commit, repeated revision rejection, and a lethal native checkpoint moving carried equipment into one corpse. This persistence path still requires live combat/field dispatch and native condition scheduling before the legacy Rust paths can be removed.

### Native checkpoint presentation

The HUD/movement view now obtains booster activity/expiry and base carry/walk limits from the validated native checkpoint when present. It adds the existing equipment additional-weight contribution once, without adding legacy Rust weight boosters again. The regression deliberately keeps conflicting legacy boosters and verifies native icons, expiry bits, weight limits and the overloaded boundary. It passes; the optimized native hit build also completed successfully.

Current live integration gap: `inventory_poll` still dispatches legacy impact/field/consume operations, and `World::step` still runs the Rust condition tick. Do not auto-bootstrap players into native ownership until these dispatch paths, custom hydration/dehydration and protected-zone policy are connected and the stock tick is disabled together. Native checkpoint infrastructure, proposals and atomic persistence are implemented; live ownership is not.

### Custom survival policy in native steps

`State::prepare_native_step` prepares a cloned input: it advances custom thirst (including the thirst-only component of imported timed treatment), sets native `CanBeHarmed` from safe-zone policy and queues dehydration in the native health-delta accumulator. It does not apply stock treatment effects or modify live health. Checkpoint preparation is immutable and repeatable, so retrying a pending step cannot spend hydration or damage twice. Native timers/wounds/boosters remain intact.

The library suite passes 115 tests; focused checks cover invalid duration/damage, safe-zone suppression and leaving protection, byte-preservation of native wounds/boosters, and timed hydration without duplicate treatment health. This helper still needs to be called by the live scheduler as part of the condition cutover; no live tick ownership change is claimed.

### Live native condition step lane

`inventory_poll` now has a native step lane for actors already carrying a committed native checkpoint. It accumulates elapsed real time, converts through the admitted campaign time factor, prepares custom policy, queues the native request, validates host/life/revision/equipment on reply, persists the result, then replaces live state after commit. Pending steps block conflicting inventory operations and player-hit reservations. Retry/stale work does not consume the elapsed-time debt. The world loop skips the Rust stock condition tick for these actors. A regression verifies 30 world frames cannot mutate their condition/treatment checkpoint. Server binary compilation and its five tests pass.

Automatic bootstrap remains disabled. Native-owned actors with pending physical/field hits currently wait rather than use legacy mutations; hit/field dispatch, native consumption intent preparation, commit-reply recovery, field overflow and PvP reservation integration must be finished before enabling conversion. Scheduler actor/socket/database end-to-end verification is still pending. Native tick timing under sustained high campaign time factors also needs throughput validation.

### Native queued hit/field dispatch

The native condition lane now prioritizes queued physical contacts and environmental pulses, translates their stock hit types/bones/penetration, and sends zero-time native hit requests. It retains the event until its checkpoint/wear transaction commits, installs the resulting state/loadout, then removes that event. Native grenades retain PvP combat tagging without applying damage a second time. Already-authorized physical contacts retain damage authority when the player subsequently enters a safe zone; environmental pulses use current protected-zone policy. Native hit calculation also calls stock `CActor::HitArtefactsOnBelt` before condition handling, matching the original actor hit order.

The server binary's five tests pass. The private socket fixture now verifies ZCV1 delivers the checkpoint and exact outfit/helmet wear together. The added artefact call is undergoing an optimized native incremental build. Remaining before automatic bootstrap: consumption intent preparation, commit-reply recovery, field overflow/throughput, direct PvP reservation path, and actor/socket/database end-to-end verification. Full weapon/projectile ownership also remains in the overall migration plan.

### Durable native commit reply recovery

Schema 23 adds one native condition receipt per player, replaced by each committed native step/hit. A SHA-256 fingerprint covers the exact typed proposal; matching life/visit/world and current committed revision are required for replay. The receipt is written in the same transaction as condition, armour and death. An exact repeat returns the committed result without rerunning effects; changed proposals remain stale. JSON float-roundtrip parsing preserves exact serialized reply values. Receipt storage is bounded by player count rather than tick count.

The live lane retains the exact persistence operation until acknowledgement and retries it with refreshed session authority after a lost/closed/error reply. It blocks conflicting inventory/fire reservations during this interval and retires retry work on actor-incarnation change. Only an acknowledged commit removes the queued hit/field event or consumes time debt.

All 27 equipment tests pass, including reopen/replay of a lethal native hit, one corpse, one receipt row, unchanged wear, and rejection of a changed proposal. Full server tests are running. The previous artefact-protection native build also passed. Live native consumption preparation and direct PvP/overflow integration still precede automatic bootstrap.

### Native consumption intent dispatch

Checkpoint-owned actors now route Consume through `PrepareNativeConsume`. This read-only session operation checks ownership, life, item revision, consumable type and required native configuration fields, and resolves the section from the database. It does not debit the item. Completed request IDs return the existing receipt rather than starting another effect calculation. The native condition lane queues a zero-time ZCM1 proposal and commits it through `ConsumeNative`; acknowledgement installs the complete condition/loadout and sends the action result. Conflicting inventory/fire operations wait while the intent or commit is pending.

All 27 equipment tests pass, including no mutation during preparation, ownership/revision rejection, cached completed requests, native effect commit and rollback. Server binary tests pass. The full server suite is being rerun after updating the artificial v4 schema fixture to remove the new native receipt table and expect schema 23. Automatic native bootstrap is still disabled pending direct PvP integration, field overflow/throughput and end-to-end native scheduler validation.

### Ordered native field batches

ZCF1 carries up to 64 ordered field pulses with one checkpoint. The native actor applies each pulse through stock artefact/condition logic, carrying outfit/helmet wear forward inside the proposal, then restores original mirror gear. It stops on death. One ZCV1 result and one atomic hit transaction commit the entire batch; acknowledgement retires exactly that queue prefix. No aggregate-power approximation is used.

The bounded codec regression passes pulse order/type/power preservation, every truncation, empty/65-pulse rejection, 64-pulse acceptance, nonfinite rejection and required wear replies. Native checkpoint standalone tests and server binary tests pass. Optimized native compilation is running; native actor batch-versus-sequential runtime verification remains pending. The full suite exposed two additional historical schema reconstruction fixtures, now updated to remove schema 23 receipt tables before testing v1/v2 migration. Full suite rerun is in progress. The overflow fallback remains a cutover blocker until native backpressure handling replaces legacy overflow mutation.

### Native condition validation and fire scheduling

The ordered-field optimized native Release build completed successfully (xr_3da and xrGame). The complete Rust suite passed: 116 library tests, 5 server binary tests, 27 equipment tests, 8 foundation tests, 13 inventory tests, 1 operations test and 9 ownership tests. Historical schema fixtures now account for schema 23 receipts.

Queued outgoing fire now waits for the shooter's pending native proposal/commit/consumption, matching victim-side exclusion. Autonomous native time steps yield to an already queued shot instead of repeatedly taking its scheduling slot; condition time debt is retained. This avoids dropping a queued shot at the final inventory busy guard and avoids condition-step starvation of the fire queue.

Remaining before automatic native-condition bootstrap: direct PvP and shotgun/knife transaction integration; bounded field overflow handling without Rust condition mutation; end-to-end native scheduling and checkpoint/logout validation. Full weapon state-machine and projectile ownership migration is still unfinished. Build/test success does not prove those cutovers.

### Ordered native physical hit proposals

Added ZCB1 for 1–64 ordered physical hits, each retaining stock hit type, power, penetration, aimed flag and named skeleton bone. The native actor batch path carries armour wear and condition/wound changes between hits and stops on death; it restores mirror equipment afterward. Both field batches and physical batches use this stock hit path. ZCF1 remains field-only at protocol validation. ZCB1 requires the combined ZCV1 condition/wear response and uses the existing host/equipment/incarnation/revision fences and exact replay cache.

Seven Rust native-condition tests and standalone C++ checkpoint/protocol tests pass, including named-bone/order decoding, all truncations, invalid fields/counts, trailing bytes and rejection of checkpoint-only responses. Optimized native compilation is in progress at /tmp/zone-native-physical-batch-build.log. Runtime equivalence of a physical batch versus sequential stock hits is not verified. Direct PvP ammo-plus-victim persistence still uses the legacy transaction and must be connected to these proposals before bootstrap; this change alone is not a live PvP cutover.

### Atomic native firearm victim persistence

FireVictim can now carry a server-only native Shot proposal bound to the reserved round profile (including weapon revision), victim condition revision and equipment generation. FireWeapon commits native full condition and wear inside the same SQLite transaction as ammunition/weapon wear and all other victims. A stale native victim aborts that transaction; a mismatched round profile rejects before debit. Native-owned actors cannot silently fall through to legacy volley or single-hit/knife condition math. Successful native volley responses install the full condition snapshot in the live world rather than synthesizing wounds in Rust.

All 28 equipment tests passed. The added two-victim native buckshot case injects failure on the second victim and proves no ammo, wear, condition, death or corpse partial commit. Successful retry preserves the exact checkpoint and one round debit. Additional checks pass for stale round, equipment and condition revisions and missing native proposals. The native shot proposal is still not assembled by the live firing scheduler (which supplies None); automatic native bootstrap therefore remains off. Native batch reply currently does not report the index of the lethal pellet, so the native volley applied_pellets diagnostic is the submitted contact count; state processing itself stops on death in X-Ray. Exact pellet-count telemetry remains to be corrected if retained.

### Native trace-bound damage and stock Gauss compatibility

NativeWeaponRules::traced_damage now exposes native weapon/cartridge damage for the live proposal coordinator. It requires the same item identity and exactly matching native launch profile for the burst index, including configuration and ammunition keys; it refuses catalog-only or stale profiles. Tests compare its power/impulse against the existing native transaction calculation and reject wrong items, missing keys and opening/sustained-profile mismatches.

The new condition hit validator incorrectly capped penetration at 100 while stock Gauss ammunition uses 150. Its bound now matches the existing native attack bridge and Rust ballistics (1000). Single-hit and batch regressions accept Gauss and reject values above the bound. All 117 library tests pass with the local Unix socket fixture allowed; standalone C++ codec tests pass. The prior ordered-physical-batch optimized native build finished successfully. A follow-up native build for the penetration-bound correction is running at /tmp/zone-native-gauss-build.log.

Live integration still requires a firing coordinator to reserve each victim while proposals are pending, cancel/release all reservations on disconnect/timeout/host restart, collect exact-fence results, and enqueue the existing atomic FireWeapon transaction once. No automatic bootstrap or production deployment has been enabled.

### Live native firearm proposal coordinator

The firing scheduler now detects checkpoint-owned victims and prepares native ordered-hit proposals from the exact trace-bound native weapon/cartridge damage. It reserves all victims before waiting, blocks conflicting victim and shooter condition/inventory work, and retains the original rewind contacts. Results must match host boot/epoch, player incarnation, condition revision, equipment generation and campaign visit. Once all native results arrive, it refreshes session expiry and submits the existing atomic FireWeapon transaction. Disconnect, timeout, expired held-trigger lease, dead/travelling actors, changed authority or invalid results cancel outstanding host requests and release victim reservations without debit.

All 6 server binary tests pass, including a disconnected-shooter regression proving every victim unlocks, the queue retires and no inventory operation is submitted. The full Rust suite is running at /tmp/zone-native-fire-full-suite.log. Automatic condition bootstrap remains disabled: native knife transaction integration, field overflow backpressure, checkpoint/logout scheduling and host-to-database end-to-end verification remain. Actual native CWeapon state-machine/projectile ownership is also still unfinished. Coordinator compilation and cancellation tests do not establish live native damage equivalence.

### Native condition scheduling, logout and shutdown

The native condition lane previously returned before the common reload/checkpoint/logout code on every poll. It now yields between native actions for queued fire, reload, due checkpoints and shutdown. Legacy hit/field handlers are explicitly excluded for native-owned conditions even when the lane yields. Accepted damage and consumption still precede housekeeping. Death retires remaining field/impact queues; completed native commits schedule the next periodic checkpoint instead of immediately duplicating their persisted condition/location write. Draining/final shutdown does not start fresh autonomous condition ticks.

The full coordinator Rust suite passed (117 library, 6 binary, 28 equipment, 8 foundation, 13 inventory, 1 operations and 9 ownership tests), and the optimized Gauss-bound native Release build completed successfully. The new scheduler regression brings server binary tests to 7 and passes periodic/final checkpoint handoff, damage priority and death queue retirement. Shutdown-specific assertions are being rerun at /tmp/zone-native-housekeeping-shutdown.log. Live native host/database validation remains pending; automatic bootstrap is still off. Native melee, bounded field overflow and full native weapon/projectile ownership remain unfinished.

### Native melee condition proposals and persistence

The live attack coordinator now supports knife slash/stab and ordered splash wound hits in addition to firearm batches. Native proposals carry an explicit attack binding: firearm round profile, or knife mode/splash selection. Knife persistence revalidates equipped/drawn ownership and attack binding, commits native condition plus wear atomically, and returns the full victim checkpoint through the same live-world update path. Firearm transactions reject knife-bound proposals and vice versa. The pre-existing catalog-derived knife reach/power/timing logic remains in Rust; replacing that with actual native weapon action ownership is still part of the unfinished migration.

All 117 library tests, 7 binary tests and 28 equipment tests pass. The native buckshot transaction regression now also exercises melee: wrong mode rejected, injected victim-write failure rolls back wear, successful retry preserves the exact native checkpoint and leaves gun ammunition unchanged. Automatic condition bootstrap remains off pending bounded field overflow/backpressure, full native host-to-database verification and remaining native weapon/projectile ownership work. The test supplies a native result fixture and does not prove actor-level hit calculation equivalence.

### Accelerated-clock native condition batching

Native condition requests previously advanced at most one campaign second per native/SQLite round trip. At accelerated game clocks this can accumulate time debt even when the server is otherwise healthy. A request now accepts up to 60 game seconds, and the native host advances it in ordered steps of at most one game second, stopping at death. The Rust scheduler still advances at most one real second of custom thirst/treatment state per proposal; only the native game-time bridge limit increases. Acknowledgement still retires time debt once, with existing exact replay and atomic commit semantics.

Standalone C++ tests verify fractional final steps, 60-step bounds, early stop at death, zero/invalid durations and request limits. All 7 native-condition Rust tests pass. Optimized native compilation is running at /tmp/zone-native-time-batch-build.log. This amortizes round trips; actual actor timer equivalence and sustained many-player throughput remain unverified. It does not resolve the separate bounded field queue overflow fallback, which remains a cutover blocker.

### Native environmental sampling without Rust condition previews

World sampling now sends native-owned actors' environmental pulses straight to the native queue, preserving authored pulse order. It no longer clones their full checkpoint and runs Rust field damage on a disposable copy. Legacy actors retain the existing calculation until cutover. The native ownership regression now runs 30 world ticks inside heat and radiation fields, verifies 10 correctly ordered pulse batches, and proves the complete condition snapshot is unchanged. The regression passes.

This removes redundant native-path calculations but does not fix field queue saturation: the old overflow fallback still needs a bounded lossless/backpressure replacement before native bootstrap. The active work remains incomplete. Native accelerated-clock compilation is still running; do not restart its live build solely because it is lengthy.

### Real native actor condition probe

Added the isolated native_condition_probe CLI (private socket, required new SQLite database, extracted catalog). It admits a real headless Zaton host through the existing durable world handshake, creates one native player mirror with empty equipment, waits for its genuine condition baseline, and compares a 12.25-game-second native batch with thirteen sequential native updates. It also restores the original checkpoint through a zero-time proposal to check mirror isolation. This validates engine-generated results rather than supplying synthetic checkpoint responses.

The optimized native accelerated-clock build completed successfully. The release probe build is still running at /tmp/zone-condition-probe-build.log; actual probe execution is pending. Prepared isolated assets/log directory: ../mechanics-test/native-condition-live-f3w2wrhw. No production or user browser state is used. Empty-equipment baseline generation is assumed zero by this initial probe and must be checked against actual execution. Broader medicine/wounds/armour and native-host-to-SQLite commit scenarios remain unverified.

### Real native condition stepping verified

The optimized native_condition_probe and real headless Zaton host completed successfully. One 12.25-game-second native update produced a byte-identical 228-byte checkpoint to twelve one-second updates plus a 0.25-second update. A zero-time request restored the original baseline exactly. Probe exit was 0; evidence is ../mechanics-test/native-condition-live-f3w2wrhw/attempt-y0bc2tpx/probe.log. The isolated host was terminated during cleanup (SIGKILL after its eight-second termination grace period); this run does not validate graceful native shutdown.

Two setup errors were corrected before the successful run: the bridge requires campaign identifier zaton-static-v1 rather than zaton, and the native world outbox requires mode0700. The harness now uses a new database per attempt and silent error handling. This is actual native actor evidence for empty-equipment time stepping and mirror isolation only. Wounds, consumables, equipped armour, ordered field effects, end-to-end native-to-SQLite gameplay and sustained capacity still require validation. Field overflow and full weapon/projectile ownership remain incomplete; automatic native condition bootstrap stays disabled.

### Real native ordered hits and replay evidence (2026-11-09)

The isolated optimized native probe in `../mechanics-test/native-condition-hits-20261109` passed: ordered radiation/psy/radiation batch equals three individual native hits byte-for-byte; a native bullet reduces health; exact request replay returns the identical result; restoring the baseline isolates the mirror. Accelerated 12.25-second stepping still equals thirteen sequential steps. These are genuine empty-equipment X-Ray actor results, not synthetic responses. They do not yet verify equipped armour, consumables, live gameplay database commits or capacity.

Probe exit was 0; host cleanup required SIGKILL after SIGTERM. The host's “termination with exit code 3” diagnostic comes from the registered SIGTERM handler (`xrDebug.cpp`), so its interrupted physics stack is not evidence of an independently occurring physics crash. Graceful shutdown remains unverified. The runner now records pre-cleanup host status and termination/kill actions separately and rejects a host already exited at probe completion. Automatic native condition bootstrap remains disabled; bounded field backpressure and native weapon/projectile ownership remain unfinished.

### Real native hit through SQLite verified (2026-11-09)

The optimized native probe now installs a genuine X-Ray baseline through the persistence worker, commits a genuine bullet-hit checkpoint plus native wear, retries the exact transaction, and reads the stored condition through a separate SQLite connection. The hit checkpoint survives byte-for-byte and the retry returns the identical result without a second revision increment. All earlier real-host stepping, ordered fields and mirror-isolation assertions also pass. Evidence: `../mechanics-test/native-condition-durable-map-20261109/probe.log` and `result.json`.

The runner now requires `--collision` as well as catalog/game/native-binary/output inputs. The first persistence attempt lacked active-map collision authority and failed; the corrected run uses the existing verified Zaton collision manifest rather than bypassing campaign authorization. This is an isolated empty-equipment native-host-to-worker/SQLite integration check, not rendered multiplayer validation or full actor/weapon migration. Native shutdown still requires forced cleanup and is not proven graceful. Bounded field overflow, automatic native condition bootstrap, equipped armour/medicine validation and full native weapon/projectile ownership remain open.

### Native ownership enforced for legacy hit transactions (2026-11-09)

Legacy `ResolveImpact` and `ResolveFields` now reject native-owned condition snapshots before calculating damage or changing equipment. This extends the existing firearm/knife/consumable ownership guards to direct impact and environmental transactions. The equipment regression sends both legacy request types after native checkpoint installation and verifies exact stored condition/revision and both equipment conditions are unchanged; the subsequent native hit transaction still succeeds. All 28 equipment integration tests pass (`/tmp/zone-native-owner-guard-tests.log`).

This is a persistence boundary invariant, not the field-queue overflow fix: the in-memory saturation fallback is still open. Native socket field messages also need ordered backpressure/retention, rather than merely increasing the peer queue or silently dropping pulses. Automatic native condition bootstrap remains off until those delivery paths are migrated.

### Native hit socket failure retention (2026-11-09)

`flushHits` previously removed queued hits for non-transient socket errors such as ENOENT/ECONNREFUSED during receiver replacement. It now retires only a completely sent datagram, retains the oldest failed packet, stops after one failed attempt, and bounds successful work to 256 packets per call. The shared flush helper is tested for EAGAIN/EWOULDBLOCK/ENOBUFS/EINTR/ENOENT/ECONNREFUSED/EBADF, short sends, zero budget, and failure after a successful prefix. An actual private Unix datagram test removes/rebinds the receiver and verifies hits arrive once in order. Run: `c++ -std=c++17 -Wall -Wextra -Werror -Isrc server/tests/native_hit_delivery.cpp -o /tmp/zone-native-hit-delivery && /tmp/zone-native-hit-delivery` (socket binding requires sandbox permission).

Optimized native xr_3da/xrGame build passed (`/tmp/zone-native-hit-delivery-build.log`). This proves socket-level retention only: a successful send still lacks application acknowledgement, native queue-full behavior and lease-expiry retirement remain, and Rust field saturation still needs ordered backpressure. No claim of end-to-end lossless delivery or complete migration.

### Real native stock medkit replay and stepping (2026-11-09)

The optimized real-host probe now uses stock `medkit` on its injured native actor, verifies a changed checkpoint and exact request replay, then compares a 12.25-game-second batch with thirteen sequential native steps from the same consumed checkpoint. Both match byte-for-byte. Earlier native fields/hits, baseline isolation and SQLite hit commit/replay assertions still pass. Evidence: `../mechanics-test/native-condition-medicine-20261109/probe.log` and `result.json`; optimized probe build at `/tmp/zone-native-medicine-probe-build.log`.

The catalog's stock medkit uses 10-second health/bleeding boosters, not `apply_time_sec`. The JSON test names use “Medicine” broadly; this evidence covers stock consumable/booster replay and time stepping, not the separate timed-influence implementation. It does not yet couple this real consumable result to an inventory portion debit; that transaction currently has synthetic-checkpoint integration coverage. Field/native delivery backpressure, automatic bootstrap and full native weapon/projectile ownership remain open.

### Native hit acceptance acknowledgement (2026-11-09, build pending)

Native hits now carry monotonically increasing sequences in ZAH2/ZAH5 packets; ZHA1 cumulative acknowledgements are fenced by server epoch and native boot. X-Ray retains sent packets until acknowledged and retries at 100 ms intervals with a bounded 256-packet send budget. Rust holds at most one decoded hit when the consumer rejects it, stops socket draining, suppresses duplicate sequences, and acknowledges only accepted or explicitly invalid/expired/lifetime-obsolete hits. A deferred hit is rechecked against actor incarnation before delivery. Native field delivery reserves space for Rust pulses already sampled that tick rather than entering the overflow fallback.

118 Rust library and 7 server binary tests pass, including an actual Unix-socket test for backpressure/no premature acknowledgement, retransmitted duplicates, wrong-boot rejection and respawn retirement. C++ tests pass for retained successful sends, errors, budgets and receiver removal/rebind. Optimized native compilation is running at `/tmp/zone-native-hit-ack-build.log` (session43803); not yet a complete runtime validation. Both native and Rust processes must be updated together; obsolete hit packet versions are no longer accepted at the socket boundary.

Acknowledgement means acceptance into Rust's in-memory work queue, not SQLite durability. Native queue-full/lease-expiry retirement and Rust-originated field overflow remain open, so this does not establish lossless delivery through process crashes or enable automatic native bootstrap. Full native weapon/projectile ownership also remains unfinished.

### Queued native hits no longer expire by age (2026-11-09)

Removed the old 1.2-second receive-age rejection from the sequenced hit payload decoder. Hits held by backpressure remain valid while publisher epoch/boot and actor incarnation remain valid. The real-socket acknowledgement regression advances world time by ten seconds with one decoded hit deferred and another packet still unread; both are accepted exactly once afterward. Duplicate/wrong-boot packets remain suppressed, and a respawn still retires a deferred old-incarnation hit without applying it. All 118 library and 7 server binary tests pass (`/tmp/zone-native-hit-ack-age-tests.log`). Native optimized build session43803 is still live; no restart or publication performed. Native lease-expiry queue clearing is separate and remains unresolved.

### Preserve hit delivery across snapshot lease timeout (2026-11-09, incremental build pending)

The native refresh path no longer clears produced hits merely because its player-snapshot lease expires. It still stops new inputs/actor presence on expiry; map changes and admission/server epoch changes explicitly clear the old delivery scope. Rust's existing boot/incarnation fences reject obsolete targets. This closes another timeout-driven loss path without accepting new native hits under an expired lease.

The real Unix-socket C++ regression now exercises production `transmit` rather than the superseded send-and-pop helper. Successful sends retain packets until the test models receiver acknowledgement; error/partial-send/budget/rebind checks pass. Native build session43803 is linking its original acknowledgement revision; the subsequent lease-retention source edit requires an incremental build after that handle completes. Queue-full behavior and durable crash recovery remain open.

### Native environment ownership routing (2026-11-09, runtime validation pending)

Added a native-condition ownership bit to the private ZAI5 actor snapshot (56-byte rows). Native mirrors copy it per incarnation. Their hit reporting now accepts actual X-Ray zone/physics-originated hits; legacy mirrors retain the NPC-only filter. Rust disables continuous-field sampling and electric-anomaly damage application for actors with both native movement and a committed native condition checkpoint, preventing the old duplicate field producer from filling those peers' queues. Actor-less/test native condition stepping retains its prior behavior.

118 library and 7 server binary tests passed after the routing changes. The condition regression checks thirty ticks with the old producer, then thirty ticks in native environment ownership with zero duplicate Rust field hits and unchanged native state. A separate snapshot assertion checks the ownership bit differs between native/legacy actors. Optimized native build session62503 is running at `/tmp/zone-native-environment-build.log`; actual anomaly/physics damage delivery remains unverified. ZAI5 requires paired native/Rust deployment; no deployment performed. Automatic native condition bootstrap remains disabled pending real zone coverage and coordinated ownership transition, native producer queue saturation and full native weapon/projectile ownership.

The previous lease-retention incremental native build passed (`/tmp/zone-native-hit-lease-build.log`). The superseded send-and-pop helper was removed; socket tests now exercise only the retained sender used by production.

### Authored radiation validation failed; activation remains off (2026-11-09)

Both optimized native environment build and release probe build passed. The extended real-host probe spawned a new native-owned actor at authored Zaton radiation volume spawn1096 (-68.04141,0.741196,-168.10297), after completing the earlier condition/persistence checks. It received no radiation hits within25seconds and exited1. Evidence: `../mechanics-test/native-condition-zone-20261109/probe.log` and `result.json`. This contradicts a claim that anomaly routing is already operational; automatic native condition activation remains off. No production deployment occurred.

Next diagnostic revision logs actual received native pose and total hit count and enables the existing private `-zone-alife-probe` output to inspect mirror creation/contact hit counts. Release probe build session70376 is running at `/tmp/zone-native-environment-probe-diagnostic-build.log`. Native zone visibility, activation and spawn positioning must be resolved before removing this gate.

### Radiation failure narrowed to native contact generation (2026-11-09)

The diagnostic rerun (`../mechanics-test/native-condition-zone-diagnostic-20261109`) also failed with zero native hits. Existing native probe output confirms the mirror at approximately(-68.042,0.744,-168.102), alive, with a collision form and hit counter0. Thus the absent radiation event is upstream of Rust decoding/acknowledgement, not simply an incorrect requested position.

Extended only the opt-in `-zone-alife-probe` diagnostic with bounded #zone rows (id,section,position,radius,enabled,state,maxPower) to distinguish an offline/disabled zone from native contact/scheduling issues. Native diagnostic build session30991 is linking (`/tmp/zone-native-zone-diagnostics-build.log`). No production behavior or activation flag was changed by this diagnostic addition; real anomaly coverage remains unproven and automatic bootstrap stays off.

### Real native radiation route verified; camera scheduling defect fixed (2026-11-09)

Zone-state diagnostics showed the authored volume was online, enabled, radius15 and maxPower0.02 while the collidable living mirror stood inside it. The failure was stock fast/slow zone scheduling based solely on Device.vCameraPosition: the headless director camera remained hundreds of metres from the actual player. Slow scheduled updates could skip the radiation zone's short blowout window. Native A-Life hosts now choose fast zone updates from authoritative player interests within the same radius+50m threshold. Non-host/single-player behavior still uses the original camera rule.

Optimized native build passed (`/tmp/zone-native-zone-interest-build.log`). Repeating the exact same isolated authored-volume test now receives five native radiation hits and confirms their native condition result increases radiation. All earlier stepping/medkit/replay/SQLite checks pass in that run. Evidence: `../mechanics-test/native-condition-zone-interest-20261109/probe.log` and `result.json` (probe exit0). This verifies actual CustomZone→actor→acknowledged socket→native condition routing for one radiation volume, not every anomaly family or all five maps. Cleanup remains forced; graceful shutdown is unverified.

Manual coverage still needed after activation: simultaneous distant players, entry/exit/crouch at hazard boundaries, electric/thermal/chemical/gravity anomalies, safe-zone policy, death/reconnect/travel and dense-scene performance. Native producer saturation, coordinated condition ownership transition and full native weapon/projectile ownership remain open; automatic bootstrap remains disabled.

### Native producer backpressure: source audit (2026-11-09)

Inspected the actual producer/update paths before adding a simulation gate. The remaining 512-entry `AlifeHostInterests::queueHit` limit still drops a new hit; acknowledged retransmission only protects entries already admitted. This is not resolved by the earlier delivery tests.

A call to `Device.Pause` is not a valid implementation: `CRenderDevice::Pause` explicitly returns for `IsHeadlessAlifeHost()`. Even removing that exclusion would be insufficient: `CGamePersistent::OnFrame` polls `refresh_host_interests` only inside `!Device.Paused()`, so a pause would stop the acknowledgements needed to resume. `CLevel::OnFrame` also commits bullet events and consumes game events independently, and `IGame_Level::OnFrame` dispatches sounds and updates objects without a pause check. Physics has its own `CPHWorld::OnFrame` / `FrameStep` and freeze state. Consequently, a single high-watermark check in the level callback cannot prove bounded lossless behavior.

Implementation requirements from this audit:

1. Separate private control-plane polling/acknowledgements from simulation advancement. Continue condition replies needed to drain Rust queues while blocked; do not execute new movement/attacks merely because control messages are polled.
2. Establish a host-only gate across scheduler, object updates, physics and bullet production, with timer handling that does not create catch-up damage after resumption. Preserve ordinary single-player pause behavior.
3. Reserve delivery capacity before consuming an actor hit. `NET_Queue_Event::get` removes the event before `CActor::Hit` routes it, so a check only in `queueHit` is too late. Audit direct `Hit` call sites as well as `GE_HIT` dispatch. A high watermark alone does not bound bursts inside one callback.
4. Bound any retained engine-event backlog too; moving overflow from `m_hits` into an unbounded engine queue is not a fix. Define an explicit unhealthy-host/recovery outcome if continued control-plane progress is impossible, rather than silently dropping damage.
5. Verify delayed acknowledgements with more than 512 generated hits, exact ordered delivery after recovery, bounded memory, continued condition RPC, epoch/life retirement and no elapsed-time burst. Test socket disappearance separately from Rust queue saturation.

No overload gate has been enabled yet. Automatic native condition ownership remains off. This audit rules out the naive pause approach; it does not establish overload safety or complete weapon ownership.

### Control polling / simulation entry points separated (2026-11-09)

Replaced the combined `refresh_host_interests` entry point with `poll_host_interests` (socket refresh and acknowledged delivery) and `advance_host_interests` (campaign clock and actor update). GamePersistent invokes both in the original order and under the original guard, preserving behavior while making the boundary explicit. Optimized native build is running in session10084, log `/tmp/zone-native-control-split-build.log`; source diff checks pass. This is preparatory code, not an enabled overload fix.

Further source evidence: `AlifeHostTargets::stepMovement` consumes armour/weapon snapshots and services condition proposals after its movement loop. The receiver clears loadout snapshots at each refresh. Therefore simply moving polling outside the pause guard would discard pending loadouts and withholding all actor updates would starve condition replies. Before enabling the gate, retain bounded latest loadout snapshots until consumed and separate condition-only servicing from movement/attack execution. No automatic ownership activation or deployment performed.

### Condition servicing and bounded pending loadouts (2026-11-09)

Extracted native condition proposal handling into `AlifeHostTargets::serviceConditions`, retaining the existing epoch/movement, incarnation, equipment, replay and state-restore guards. Normal movement still calls it in the original order; it now has a separate entry point for a future stalled-host control path. It does not independently move actors or execute weapon attacks.

Armour and weapon snapshots now retain the latest entry per player across socket polls until the movement consumer copies them. The pending vectors are bounded to512 players, replacing an existing player's snapshot even at capacity; lease/map/admission retirement clears old pending state. New `ZonePendingSnapshots.h` is shared by both queues. A standalone C++ regression passes 9,998 repeated replacements, full-capacity rejection without eviction, replacement by a new incarnation, consumption and zero-capacity behavior. This tests storage semantics, not full paused-host operation.

The earlier optimized build session10084 failed because the header changed while its precompiled header was in use (explicit compiler diagnostic). A fresh optimized build after the header edits is running at `/tmp/zone-native-control-mailbox-build.log`. No overload gate is enabled, no activation/deployment performed. Further work must wire condition-only servicing, gate every simulation producer, reserve capacity before event consumption, and exercise real >512-hit saturation without shifting growth to the engine event queue.

### Paused control polling wired (2026-11-09)

GamePersistent now polls the native private socket outside the ordinary pause guard; campaign-clock/actor advancement and scheduler updates remain inside it. While paused, polling invokes the separate condition proposal handler, retaining equipment-generation/readiness checks and exact replay behavior. Pending loadouts remain retained until the normal consumer runs. This supplies the control-plane path needed for a later overload gate; it does not turn the existing ordinary pause into a complete headless simulation gate. In particular, level publication/movement/attack dispatch and other producer callbacks still need explicit overload coordination.

Standalone native condition checkpoint/protocol/replay regression and bounded pending-snapshot regression pass. Native build session1842 remains live at `/tmp/zone-native-control-mailbox-build.log`; the two source-file wiring edits made during this build require a subsequent incremental build after it completes. No build restart on timeout, activation, local publication or deployment performed. Real paused-control servicing and producer saturation remain unverified.

### Publication callback pause guard (2026-11-09)

The source audit found `publish_host_npcs` is not merely presentation: it calls `stepMovement` and consumes queued attacks. Added an ordinary-pause guard that services condition proposals and returns before those simulation paths. The polling callback still handles acknowledgements and corpse delivery. This closes another bypass in the preparatory control separation; headless overload gating, pre-consumption hit capacity reservation and bounded upstream production remain unfinished.

Inspected actual hit dispatch: `CGameObject::OnEvent` decodes GE_HIT/GE_HIT_STATISTIC then invokes Actor::Hit; Lua `CScriptGameObject::Hit` creates and sends GE_HIT rather than directly mutating actor health. `NET_Queue_Event::get` pops before dispatch. Capacity reservation must therefore precede that pop, and must coexist with epoch/actor lifecycle events rather than blindly stalling every event. Native optimized build session1842 is still live; an incremental build after completion is required for source edits during compilation. No runtime saturation claim or deployment.

### Native validation build recovery (2026-11-09)

Build session1842 finished with a link failure: eleven expected object files were absent, despite their compile steps appearing in the log. No source compile error was reported. Incremental session69848 (`/tmp/zone-native-control-final-build.log`) regenerates missing objects and includes the later control-path source edits; currently linking. The cause of the missing files is not established. Do not treat the prior build as passed. Next validation is the existing isolated real-host condition/radiation probe with a new disposable output directory; no browser/manual multiplayer session is touched.

The incremental optimized build session69848 passed (all16 steps, final native xrGame link). Started real-host regression session10736 with fresh evidence directory `../mechanics-test/native-condition-control-mailbox-20261109`. Probe is still running; no result assumed. This validates existing condition/radiation behavior after refactoring, not saturation or full simulation pause.

### Control-path native regression passed; pre-dispatch capacity check added (2026-11-09)

Isolated real-host regression `../mechanics-test/native-condition-control-mailbox-20261109` passed (probe exit0): native condition batch/sequential equivalence, medicine and impact replay, durable SQLite impact/replay, restored mirror and five actual authored-volume radiation hits. Cleanup still required SIGKILL; graceful shutdown is not verified. This proves the refactor preserved those exercised behaviors, not paused-host or overload correctness.

Added `hasHitCapacity` / `host_hit_capacity` and a native-only check in `CLevel::ProcessGameEvents` before `NET_Queue_Event::get`. When the front event is a hit to a native player mirror and the acknowledged delivery queue is full, the event remains queued instead of being consumed and dropped in Actor::Hit. Capacity is checked again defensively by queueHit. Non-hit events and non-native actors retain the old dispatch behavior. This is a single-thread dispatch capacity guard, not a claim that all producer memory is bounded: upstream simulation gating remains required, and lifecycle events behind a blocked hit must be considered in the full solution.

Optimized build session38554 is running at `/tmp/zone-native-hit-reservation-build.log`; source whitespace checks pass. No activation/deployment. Physics audit confirms CPHWorld registers its own Device.AddSeqFrame callback (optionally multithreaded); it cannot be stopped solely by skipping the level callback. The complete overload gate must coordinate that callback and elapsed simulation time as well.

### Headless delivery pause integrated, validation pending (2026-11-09)

Added a narrowly named internal pause reason (`zone hit delivery`) that may freeze headless simulation timers; ordinary headless UI/script pause requests remain ignored. After polling, GamePersistent checks outbound hit capacity and pauses/resumes accordingly. Its scheduler and actor advancement remain gated, while polling and condition servicing continue. Headless CLevel::OnFrame and the separately registered physics callback now return while paused. The constant-FPS branch respects this headless pause, and level teardown releases paused timers. Existing native publication guard prevents movement/attack dispatch while paused.

This is an unvalidated overload implementation, not a passed safety claim. The pre-dispatch capacity guard retains already-queued hits; stopping upstream callbacks prevents continued frame-by-frame production once saturation is observed. Remaining verification must examine callback ordering/in-flight work, peak event backlog from one frame, lifecycle progress, condition RPC and exact delivery after delayed acknowledgement. Socket disappearance, lease timeout and resumed timer behavior need explicit tests. Automatic native condition bootstrap remains disabled.

Build session38554 is still running for the prior header revision. These source edits need an incremental build afterward; no restart, publication or deployment performed.

### Real saturation probe prepared (2026-11-09)

Added opt-in `--hit-backpressure` to the isolated native condition runner. The Rust probe withholds hit draining/acknowledgements while continuing snapshots until the real host logs its 512-hit delivery pause. It then requires a zero-time native condition RPC to complete with exact state, drains at least512 accepted hits, requires the host's resume transition, and continues the existing authored-radiation test. Uses actual zone-generated hits; no reduced-capacity production setting or synthetic native injection. Queue fill has a600-second deadline; runner must use `--timeout 900`. This checks recovery/count and control responsiveness, not exact per-event sequence auditing or peak process memory.

Probe release build session70191 is running at `/tmp/zone-native-backpressure-probe-build.log`; runner syntax and scoped diff checks pass. Native build session38554 remains live, followed by a required incremental build for the simulation-gate source changes. Saturation run has not started yet; no passed result claimed.

### Saturation regression running (2026-11-09)

Native capacity-check build38554 and optimized Rust probe build70191 passed. Final native timer/physics integration build34599 also passed (`/tmp/zone-native-hit-gate-build.log`). Started isolated actual-radiation saturation run1330 with `--hit-backpressure --timeout 900`, evidence `../mechanics-test/native-condition-backpressure-20261109`. The runner now independently fails if the host log contains any `Zone A-Life hit queue is full` report, even if probe assertions pass. Test remains live; no saturation result claimed. No deployment or ownership activation.

### Actual 512-hit saturation/recovery regression passed (2026-11-09)

Run1330 completed successfully: `../mechanics-test/native-condition-backpressure-20261109/result.json` has passed=true, probeExit0 and nativeHitOverflowReports0. Authored radiation filled the native512-entry acknowledged queue with Rust deliberately withholding its hit receiver. The host logged blocked, serviced a zero-time condition RPC with exact checkpoint while blocked, then logged resumed after draining. The probe accepted513 hits during recovery and subsequently received/applied five further radiation hits. Existing batch/medicine/replay/SQLite checks also passed. This is actual native zone/event/socket/control-path integration evidence, not a reduced-capacity simulation fixture.

Scope limits: count513 includes resumed production, so it is not an exact sequence-by-sequence proof of every generated event. Peak memory/engine backlog, prolonged stalls, multi-player simultaneous bursts, receiver removal, death/travel during blocking, and crash durability still require coverage. Cleanup was forced (SIGTERM then SIGKILL); graceful native shutdown remains unverified. Automatic condition activation remains off pending ownership transition and broader hazard coverage. Full native weapon state-machine/projectile ownership is still unfinished. Nothing deployed.

### Sustained pause regression started (2026-11-09)

Extended the real saturation probe with a five-second hold after the queue-full pause. During that hold it keeps publishing snapshots and requires the native `zone-alife-probe.tsv` simulation diagnostic to remain byte-identical, then performs the condition RPC and recovery checks. This observes stopped level diagnostics over time; it is not a peak-memory measurement or proof that every timer is frozen. Release probe build76750 passed; run37593 is live in `../mechanics-test/native-condition-backpressure-hold-20261109`. No result yet.

Rechecked the next major ownership gap in source: `CWeaponMagazined::NativeFireRules`/`publishWeaponRules` export authored parameters, but Rust `schedule_reload` still chooses phase deadlines and `prepare_native_fire` constructs hits using `NativeWeaponRules::traced_damage` (or Rust knife profiles). Parameter parity is not native CWeapon state-machine ownership. Native Action/Reload/Fire and BulletManager event paths must become authoritative with persisted ammo/replay/transaction coordination before that requirement can be closed.

### Sustained saturation and weapon callback ownership (2026-11-09)

The extended probe reached saturation, kept its simulation diagnostic byte-identical for five wall-clock seconds while snapshots continued, completed the blocked-host condition RPC, recovered512hits and resumed. Six subsequent radiation hits applied; earlier checkpoint/medicine/persistence checks also passed. Evidence `../mechanics-test/native-condition-backpressure-hold-20261109/probe.log` and `result.json`; run37593 exited0, passed=true, zero overflow reports. Cleanup still required SIGKILL. Still not a peak-memory or multi-player lifecycle proof.

Corrected three CWeaponMagazined reload/empty-magazine callbacks to use the weapon's actual CActor parent rather than global Actor(). Headless multi-player mirrors otherwise route these callbacks to the director actor. Ordinary single-player ownership still resolves to the same actor. This removes a prerequisite actor-ownership defect; it does not enable native reload/fire authority. Optimized incremental build77733 is running at `/tmp/zone-native-weapon-owner-build.log`; callback execution with multiple native weapon owners remains unverified. No deployment.

### Native weapon ownership prerequisites (2026-11-09)

Owner-callback optimized build77733 passed. Inspected actual Reload/TryReload/ReloadMagazine: it consumes CWeaponAmmo objects from the owner's inventory, and CHudItem animation completion invokes OnAnimationEnd→ReloadMagazine. Current player mirror reconciliation supplies the equipped weapon and its magazine but not the full reserve-ammunition inventory. Native reload execution therefore requires revision-fenced reserve-ammo mirroring/proposals plus animation-driven completion, not simply calling Reload and keeping Rust's timer.

Fixed a second ownership leak: native CActor mirrors now return false from unlimited_ammo regardless of the headless director's global AF_UNLIMITEDAMMO developer setting. Non-mirror and browser/single-player behavior is unchanged. This prevents a future native action from creating ammunition through a host debug flag. Incremental optimized build is running at `/tmp/zone-native-finite-ammo-build.log`; runtime multi-actor ammo/callback tests remain pending. No native reload cutover or deployment claimed.

### Revision-fenced native reserve-ammo transport (2026-11-09)

Finite-ammo optimized build44190 passed. Extended equipped-weapon snapshots to ZAW3 with the inventory generation and up to128 carried ammunition boxes (stable item ID, item revision, authored section, positive16-bit round count). Rust reads these in the same SQLite transaction as equipment, restricted to carried rucksack/belt entries; native parsing rejects duplicate IDs, malformed/trailing payloads, excessive counts and invalid generation. Pending loadout storage retains the reserve snapshot with the weapon. ZAW1/2 are no longer accepted: native and Rust must be rebuilt/updated together. No deployment/local publication; existing release probe binary predates this wire update and must be rebuilt before the next paired runtime test.

This transports reserve state only; native CWeaponAmmo spawning/reconciliation, ammo delta proposal/commit/replay and Action/animation-driven reload cutover remain to implement. Do not claim native reload ownership. Initial two weapon tests passed; expanded exact ammo payload/duplicate/zero-round checks are running in48268 (`/tmp/zone-native-reserve-tests-final.log`). Optimized native build71722 is running at `/tmp/zone-native-reserve-build.log`. Scope/source checks pass.

### Native reserve-ammo objects implemented, validation pending (2026-11-09)

Added per-target stable-ID→native-ammo mappings and reconciliation before equipped-weapon update. Authored box capacity is validated before mutations; new CSE_ALifeItemAmmo/CWeaponAmmo mirrors use the stock spawn/ownership/inventory path and target-only non-persistent flags. Removed/section-changed boxes are rejected/destroyed. Existing boxes accept counts only on a new item revision, so repeated snapshots cannot replenish ammunition consumed by a native action. Inventory-generation equality with armour guards inconsistent equipment snapshots. Actor destruction uses the existing recursive child cleanup. Ready reserve generation is tracked for the future action lane.

This is mirror setup, not reload authority: native action/proposal lifetime, ammo delta commit/replay, animation completion and Rust reload cutover remain unfinished. Stock ammo objects are placed in the native rucksack; original belt/ruck placement and selection-order parity need consideration before enabling actions. Actual mirrored counts, ownership/removal and no-refill behavior still need runtime probe coverage.

Expanded ZAW3 Rust packet tests passed after correcting the test's hard-coded section length. Prior native build71722 failed at link due to a missing mathTrig.cpp.o (not a source compile diagnostic). Rebuild25419 includes reconciliation and is running at `/tmp/zone-native-ammo-mirror-build.log`. No paired runtime validation/deployment yet; rebuild the release Rust probe/server before using ZAW3 native binaries.

### Consumed-box tombstones and ammo diagnostics (2026-11-09)

Review found a refill path despite revision-guarded count updates: if stock reload consumes/destroys a box before persistence commits, reconciliation saw a missing native entity and recreated it from the old snapshot. It now retains the applied revision as a tombstone and refuses recreation until a newer revision arrives (authoritative deletion removes the mapping). Reconciliation also checks native section identity and invalidates stock inventory caches when accepting a new count.

Added bounded #ammo rows (native owner/item IDs, section, current/capacity rounds) to existing opt-in `-zone-alife-probe` diagnostics. Normal gameplay still does no diagnostic filesystem work. This enables a real reserve-box probe; it is not itself runtime verification. Build25419 remains live; source edits after its start require an incremental build. A reserve-specific probe must provision a weapon and boxes and observe diagnostics directly: the existing condition probe assumes equipment generation0 and cannot simply be seeded without updating its ownership fences. No deployment or reload cutover.

### Reserve-ammo integration probe prepared (2026-11-09)

Added isolated `--reserve-ammo` mode to the existing runner/probe. It provisions an actual stock AK-74 plus FMJ/AP boxes through Database::provision_inventory_item in a new database, waits for native #ammo diagnostics with correct owner/counts, updates one persisted revision/count and requires stable native IDs, deletes the second box, then holsters and requires mirror removal. Direct SQL mutations are confined to this disposable harness; they are not a production write path. This mode exits before the generation0 condition tests. It does not yet exercise actual native consumption/tombstones/reload transactions.

Probe release build98702 is live at `/tmp/zone-native-reserve-probe-build.log`; Python syntax and source diff checks pass. Native build25419 failed at link due to missing renderer r2_loader.cpp.o. The renderer agent confirms its builds/cleanup do not touch the native build tree. Cause remains unknown; incremental7275 (`/tmp/zone-native-ammo-mirror-final-build.log`) regenerates it and includes late tombstone/diagnostic source changes. No runtime result or deployment claimed.

Reserve probe release build98702 passed (45.53s). Native incremental7275 is linking; reserve runtime probe is not started yet.

### Native reserve-ammo integration passed (2026-11-09)

Native incremental7275 passed. Paired ZAW3 runtime probe65333 passed with a real headless X-Ray host and a newly provisioned AK-74/FM J+AP inventory: two boxes appeared with correct native owner/counts; a persisted revision/count update retained both native IDs; deleting AP removed only that box; holstering removed the remaining reserve mirrors. Evidence `../mechanics-test/native-reserve-ammo-20261109/probe.log` and result.json (passed=true,probeExit0,zero overflow reports). Host was alive before cleanup; cleanup still used SIGKILL after the known SIGTERM handler behavior.

This proves snapshot→native inventory reconciliation for that fixture, not CWeapon reload execution or persistence of native consumption. Next is an opt-in isolated stock Action(kWPN_RELOAD) execution probe, then a revision-fenced native action/proposal lane with persisted ammo deltas and exact replay/abort semantics. Actual consumption/destruction tombstone behavior remains untested until that probe runs. No activation/deployment.

### Stock native reload action passed (2026-11-09)

Added an opt-in disposable-host reload probe, guarded by headless mode plus both probe flags. Once the mirrored weapon and reserve inventory are ready, it invokes original Action(kWPN_RELOAD,CMD_START) once; it does not manually call ReloadMagazine or synthesize animation completion. Opt-in diagnostics report actual magazine count, state and pending flag. Optimized Rust probe7251 and native51759 builds passed.

Run50223 passed: real AK-74 loaded23FMJ rounds from the native box, left17AP rounds untouched, returned to idle/non-pending, and remained unchanged for five seconds while original snapshots continued. Persisted FMJ count remained23, confirming private execution did not silently write SQLite. Evidence `../mechanics-test/native-reload-action-20261109`, probeExit0,zero overflow reports. The depleted FMJ box remained present at0 in diagnostics: this verifies count non-refill, not the destroyed-box tombstone case. Cleanup remains forced.

Next required implementation is the authorized revision-fenced action lane and exact native ammo/weapon result commit, with replay/abort and stale-life/gear fencing; then broader weapon state coverage and fire/projectile cutover. No deployment.
