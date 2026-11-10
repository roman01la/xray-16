# STALKER multiplayer survival mechanics

Agreed mechanics for the first playable survival release. Call of Pripyat's
single-player inventory, item definitions and weapon behaviour are the reference.
The multiplayer server owns shared world state and durable changes. Existing
combat and NPC fixtures demonstrate integration, not completed gameplay.

The core loop is to leave a safe zone, scavenge, fight or avoid threats, return
with supplies, and prepare for another trip. Target population remains 100–200
players; outstanding capacity and recovery gates are tracked in [PLAN.md](PLAN.md).
Playable checks, run results and deferred mechanics are tracked in the
[manual test plan](MECHANICS_TEST_PLAN.md).

## Inventory

Preserve the original inventory screen, grid presentation, icons, tooltips,
drag-and-drop, context menus, equipment slots and quick-use bindings. Preserve
corpse and container search interactions. Do not introduce a new list inventory,
pocket capacity system, backpack progression or fixed-capacity packing puzzle.

Carrying is governed by the original weight rules. The actor can pick up items
while overloaded; excess weight affects movement rather than simply rejecting
pickup. Preserve the original thresholds, stamina effects and equipment modifiers.
The multiplayer implementation must explicitly reproduce these rules on the Rust
server; single-player-only engine checks do not automatically cover multiplayer.

Keep weapon slots and their compatibility rules, outfit and helmet behaviour,
detectors and other equipment, the artefact belt and outfit-dependent artefact
capacity. Equipped items apply their original effects. Keep original visual
stacking/grouping without discarding differences between individual items.

| Item | State that must survive transfers and recovery |
|---|---|
| Weapon | Condition, loaded ammunition, ammunition type, attachments and upgrades |
| Outfit or helmet | Condition and upgrades |
| Ammunition | Type and remaining quantity |
| Consumable | Quantity or remaining uses where applicable |
| Artefact or detector | Original item type and properties |

Use the original item definitions and configuration values. Do not invent new
inventory restrictions or simplify item behaviour to match the current fixtures.

## Weapons

Use the single-player weapon behaviour, including weapon-specific reloads,
ammunition compatibility and selection, unloading, attachments, fire modes,
condition and malfunctions. No new detachable-magazine system and no universal
simplified reload model. Connect ammunition, weapon and armour state to actual
owned items rather than the fixture's fixed loadout and reserve ammunition.

## Loot

Reuse single-player authored world placements and stash locations. Import the
existing data rather than hand-authoring a replacement location set. The server
owns shared contents: players see the same item and only one pickup can succeed.

Replenish loot gradually with population limits and a player-proximity exclusion.
Keep quantities, intervals, rarity and exclusion distances configurable. Preserve
location context and existing item definitions when deriving replenishment rules.
Story-triggered rewards and quest objects require explicit classification before
being included in repeatable shared loot; do not blindly replay single-player
quest scripts for each connected player.

Dropped items remain temporarily and then expire. Private storage persists.
NPC loot should reuse appropriate single-player definitions when the corresponding
PvE actors are implemented. Item persistence must prevent server restart from
silently restoring already-looted one-time placements.

## Death and respawn

Death transfers everything carried to a lootable corpse, including equipped
weapons, armour, artefacts, detector, ammunition and supplies. There are no
protected carried items. Personal storage survives death.

Corpses eventually expire. Reconnecting does not undo death or restore lost
items. Respawn grants minimal starter equipment as a new grant; it does not
recover or duplicate the previous life's equipment. Starter kit, respawn delay,
spawn locations and corpse lifetime remain balancing parameters.

Disconnecting outside protection leaves the character in the world for the
configured logout period. A player can return to that same body while it lives.

## Safe zones and storage

Safe zones prevent hostile actions and protect players when their PvP combat
lock is clear. A damaging PvP hit starts or refreshes the lock for both players.
Each player has private persistent storage and must physically reach it to deposit
or retrieve items. Trading, vendors and currency follow once scavenging and item
circulation work.

## Survival and PvE

Implement health, bleeding, stamina, hunger and thirst. Sprinting consumes stamina;
carried weight affects endurance according to the retained inventory rules.
Bleeding requires treatment. Hunger and thirst create supply pressure without
constant interruption. Original medical and consumable definitions remain the
baseline; any additional survival effects must be specified explicitly.

PvE runs CoP's native A-Life simulation. A-Life supplies smart terrains, squads,
navigation, NPC behaviour and the stock inventory of armed NPCs. Rust applies
multiplayer player damage, safe-zone rules, item ownership and durable transfers.
The stationary test NPC is a fixture for the transport harness.

## Authority and persistence

Players use a portable save key stored locally; the server stores its credential
hash and stable identity. Copy reads an enrolled key directly from browser
storage, including while Rust is offline. Import validates the key with Rust
before changing the profile. The save panel stays scrollable inside a short
viewport and releases the game's pointer lock while it is open.

On local Zaton, one Chrome profile copied its key while Rust was stopped. A
second profile kept its own save when given an unknown key. Opening the valid
key restored the original principal, life and all seven item records, including
the authored 60-round ammunition box. After Rust restarted, the recovered
profile loaded the same character and inventory without entering the key again.
The public Zaton release passed a separate two-profile smoke check for the same
principal, life and six-item starter inventory.
[Portable save-key evidence](acceptance/multiplayer-save-key.json)
No email/password account system is required.

The browser presents inventory and requests actions. The server validates pickup,
drop, equipment changes, consumption, reload/unload, attachment changes, looting
and storage access. Validate ownership, item compatibility, actor state, interaction
distance and relevant world rules. Clients cannot create authoritative items or
supply their own damage, ammunition or condition values.

Every item has a stable persistent identity. Ownership and location changes are
atomic and replay-safe. A death, pickup, transfer or disconnect cannot leave an
item both in a corpse/world container and in a player's inventory. Retries after
lost replies must recover the committed result rather than duplicate the action.
Visual grouping does not merge distinct condition or upgrade state.

Other players see relevant equipped weapons and clothing. Inventory contents are
private except when legitimately exposed through looting or another interaction.
WebRTC gameplay messages use binary encoding; existing HTTPS persistence APIs
remain JSON. Single-player saves, settings and runtime behaviour stay separate.

## Implementation order and acceptance

| Step | Deliverable | Acceptance |
|---|---|---|
| 1. Original inventory and one world item | Map original item definitions to durable server items; connect the existing inventory UI to authoritative actions | Two clients can pick up, equip, use, drop and re-loot the same item; conflicting pickup grants it once; reconnect/restart preserves it |
| 2. Original loot locations | Import authored placements/stashes and classify conditional items | Shared contents agree across clients; looted state survives restart; replenishment obeys limits and proximity rules |
| 3. Equipment and weapon state | Connect original weapon, ammunition, armour and attachment behaviour to owned items | Reload/unload and equip/use actions conserve items and ammunition; condition and upgrades survive transfers |
| 4. Full-loss death and storage | Atomic corpse transfer, persistent private storage, respawn and expiry | Every carried item leaves the dead character exactly once; storage remains; retries/reconnect cannot restore the old loadout |
| 5. Medical and survival systems | Bleeding, treatment, stamina, hunger and thirst | Effects are server-authoritative, consume the correct items and survive reconnect as specified |
| 6. Logout and safe-zone policies | Vulnerable logout and combat-entry rules | Disconnects and zone boundaries cannot bypass the agreed combat consequences |

For step 1, include death transfer in the vertical-slice test before generalising
corpse/storage mechanics in step 4. Verify actual engine UI and two browser clients,
not just protocol fixtures. Continue single-player regression checks and revisit
relevant community implementations at subsystem boundaries as required by PLAN.md.

## Implementation checkpoint — 2026-11-08

Step 1 remains **in progress; the original menu opens and single-item Drop, rifle equip, belt placement, outfit replacement and drag placement are verified, but the full UI acceptance gate is open**.
The public alpha runs the unified browser build and server from `4d207bf8`.
A public WebRTC smoke test joined Zaton and received the six-item starter
inventory. The checkpoints below identify the scope of each additional test.
Single player streams the campaign's five maps from the shared asset pack.
Public multiplayer simulates Zaton. The local campaign map and travel work is
tracked below.

- Original archive/configuration importer (`tools/game-configs.mjs` and
  `export-item-catalog.mjs`): engine LZHUF indexes, safe LZO payload decoding,
  resource/patch/loose precedence, includes, inheritance and section provenance.
  The installed CoP data resolves 4,109 sections from 187 files; Rust recognizes
  238 survival item definitions. Export SHA-256:
  `f1a21f313ae7b0a80e86c4e6fdb805b914cb5b8a78e331ae0cf80d29adde8d60`.
  Generated game data stays outside Git.
- Catalog-backed item state validation and equipment placement: CoP slot offset,
  either ordinary weapon slot, outfit/helmet compatibility, outfit-dependent
  belt capacity, atomic displacements and belt return on outfit removal. Weight
  includes partial ammo boxes, loaded cartridges, attachments and upgrades.
  No weight-based pickup rejection or new carrying limit is introduced.
- Schema v6: one stable item ID/location/revision; pickup/drop/equip and replay
  outcome commit together. Death moves every carried placement to a corpse while
  private storage stays intact. Per-life starter grants, delayed durable respawn
  and bounded expiry of corpses/dropped containers are implemented.
- Binary WebRTC inventory paging and movement commands use authenticated session
  authority, authoritative 3D position and the existing bounded SQLite worker.
  The simulation polls replies without awaiting database work. Death/respawn is
  connected when `ZONE_ITEM_CATALOG` enables survival mode; original fixture mode
  remains available without that setting. Browser mutation intents persist until
  a durable outcome is known and use the same request ID after lost replies.
- Own-inventory paging is private, generation-checked and bounded to fit control
  messages. The browser adapter assembles coherent views for the engine; it is
  not a replacement inventory UI. No client can mint items or supply item state.
- The application-pthread bridge now delivers coherent inventory views to a
  native C++ presentation store. It retains only an in-flight view and the latest
  replacement, carries all item state through a validated binary WASM ABI, and
  clears on disconnect. Native action intents route through the durable browser
  journal; a delayed intent cannot act for a later life. The optimized unified
  engine rendered Zaton and reported the server's six-item starter inventory.
- Native presentation actor and original item objects now back `CUIActorMenu`.
  The optimized browser build renders the original inventory screen, context
  menu, icons and weight display. A real menu Drop moved the same bandage ID
  into a server world container at revision 1 and reconciled six carried items
  to five. This used the synthetic server world with Zaton visuals, not a
  real-map loot acceptance test. Rifle equip, drag between both weapon slots,
  return to the rucksack and reconnect after Drop also passed; exact IDs and
  revisions are in `acceptance/native-inventory-menu.json`. Local actor simulation and campaign callbacks
  remain disabled in multiplayer. The same latest optimized build passed a
  single-player new game, movement, original inventory and story-script smoke
  check; saves remained under `stream-cop/_appdata_/savedgames`.
- Lost inventory replies now retry with bounded backoff using the journaled
  request ID and life. Closing the session cancels retries. The optimized
  wasm64 probe compiles the production menu intent bridge and checks pointers,
  unsigned revisions/lives and drop/rucksack/slot/belt intent fields.

The latest optimized engine also passed original-menu exact belt-cell placement,
occupied-cell replacement, double-click placement into a free belt cell, sealed
outfit replacement with incompatible equipment returned to the bag, and grenade
equip into slot 4. A server restart and browser reconnect preserved all 12 test
item IDs, revisions and placements, and restored the SEVA suit in the native menu.
This used an isolated starter-kit override; the server has been restarted with
normal six-item development defaults. Grenade combat is not covered by this check.
Evidence: `acceptance/native-inventory-menu.json` and `native-outfit-restart.png`.

The browser journal now supports a durable multi-item move batch, with all request
IDs, item revisions and the originating life persisted before transmission. Lost
middle replies and acknowledgement-storage failures are covered by tests; recovery
replays the original command without skipping items or rebasing to a later life.
Native stacked-item Drop all and rucksack batch drops now use this path without
locally removing menu cells before acknowledgement. The optimized browser build
passed a 40-bandage original-menu Drop all: 45 item IDs remained conserved, all 40
bandages moved to world containers at revision 1, the other five stayed carried,
and the native menu reconciled to 0.5 kg. Evidence:
`acceptance/native-inventory-batch.json`. This records the stacked-drop check; subsequent native pickup evidence is
recorded in `acceptance/native-world-pickup.json`.

The combined original-menu run verified both alternate weapon slots, headgear
replacement, the sealed SEVA suit and direct drag between exact belt cells.
The multiplayer belt handler sends a request for same-belt drags so the saved
slot follows the native menu. The browser kept 38 and 9 rounds in two
condition groups. After a single drop and an interrupted Drop All, it replayed
one committed and two unsent commands across a Rust restart. Every box kept
its original item ID, rounds and condition.
[Mixed inventory evidence](acceptance/native-mixed-inventory.json).

Nearby public loose-item discovery is now implemented in Rust and the binary
control codec (opcode 8, 24-byte request: sequence plus item cursor). It uses the
server session's current position and a 32 m presentation radius; pickup still
uses the original interaction distance. Each page is capped at 32 items and a
12 KB JSON-size budget before binary encoding. Expired drops, other maps, carried
items, storage and corpse contents are excluded. Concurrent traversals are
explicitly eventually consistent; ownership mutations revalidate current state.
Schema v7 adds a nearby-container lookup index, preserving existing items.
Tests cover pagination, full item state, binary response size, authority/life
checks, corpse privacy and discovery versus pickup distance. The optimized local server now runs schema v7 after a database backup.
Native world-item objects and Use pickup are connected; simultaneous two-engine
contention and real-map acceptance remain incomplete.

The browser now scans discovery pages periodically, gives pending inventory
mutations priority, and publishes only complete traversals. Death/life changes and
disconnect discard stale results. World-item views cross the worker boundary with
bounded latest-value delivery. The native parser preserves full item state paired
with source container and position, rejects malformed/truncated data before
replacement, and is polled at the engine frame boundary. Focused tests cover scan
failure/retry, life changes, worker backpressure and the real C++ parser under
address/undefined-behaviour sanitizers. The original native item objects and pickup indicator now receive these views.
The original Use binding sends a stable item/source/revision intent through the
same durable journal. Rendering and client selection do not transfer ownership.
A sequential cross-character native test collected a bandage from the earlier
40-item drop, dropped it again and re-picked the same ID. The corrected client
also passed an uninterrupted carried revision 4 → world revision 5 → carried
revision 6 round trip with full item state conserved. Evidence:
`acceptance/native-world-pickup.json`. This remains synthetic-world acceptance;
simultaneous two-engine contention, real-map pickup/occlusion, corpse search and
consumable use remain open. Client-side static occlusion filtering is not proof of
server-side line-of-sight enforcement.

The current server source now checks interaction visibility against the shared
static collision map inside the inventory transaction, using authoritative eye
height and position. Unit coverage rejects pickup through a wall for standing and
crouching players, rejects real-map authority without geometry, and accepts a
reachable item. This is fixture verification; real-map browser acceptance remains
open. Expired world/corpse containers reject pickup before the cleanup sweep.

Schema v8 adds per-container generations for coherent corpse-content pagination.
Binary commands discover nearby corpse IDs/positions without revealing contents;
opening every contents page requires current life, range and visibility authority.
A contents mutation invalidates subsequent pages. Integration coverage verifies
bounded pages, pickup-induced conflict, distance denial, private-container denial,
and expiry. The full Rust suite and six JS/Rust binary-control tests pass. The
local corpse-menu fixture runs the optimized schema v8 server in a separate database.

The browser corpse-search adapter is now included in multiplayer staging. It
restarts conflicting paginated reads, publishes only complete generations, clears
contents after denied access, and cancels late replies after dismissal, source
switch, death or disconnect. Take-all journals exact item revisions through the
existing batch recovery path, then re-reads server authority. Worker messages
carry life/source/generation checks, with one in-flight and one latest view; an
explicit empty view survives backpressure to close stale native contents. Tests
cover concurrent loot, stale clicks, partial take-all results and late replies;
28 focused adapter/journal/worker tests pass. Native C++ polling is now implemented through a versioned corpse-search ABI.
Delivery sequence is independent of each corpse's contents generation, so switching
to a different corpse with a lower generation is valid while delayed deliveries
are rejected. An explicit closure clears native contents. The real C++ parser
passes address/undefined-behaviour sanitizer checks for truncation, malformed
payloads, source switching, stale sequence and closure. The application-pthread
test verifies that corpse polling cannot activate a dormant worker, delivers the
view only after the snapshot hook claims the session, and removes hooks on close.
The optimized Release build now projects discovered bodies into the world and
opens the original dead-body search menu through Use. The server provides contents
after checking life, reach and visibility. Take All, double-click and drag to the
bag use the same journal and reconcile from the server response. The native corpse
panel supports taking items. Direct equip from the corpse and putting items back
into it are outside this verified interaction.

In Chrome, the seeded corpse transferred four distinct item IDs through the three
menu paths. Each item gained one revision and retained its condition and uses.
SQLite confirmed the corpse was empty. The same engine loaded the local Zaton
campaign save and opened its original inventory. See
[the acceptance record](acceptance/native-corpse-search.json). The test used the
synthetic server world with Zaton visuals. Gameplay death, real-map interactions,
and contention between two actual engine clients still need playable checks.

Authored loot now has a local export and an opt-in server import. Run
`node server/tools/export-loot-locations.mjs GAME_DIR ITEM_CATALOG OUTPUT_JSON`
and set `ZONE_AUTHORED_LOOT` to that export with the original Zaton collision
manifest and item catalog. The exporter reads the original spawn graph and joins
each item position to its stash definition. The marker and item coordinates
remain separate, as in the original treasure manager. The CoP multiplayer
item respawner also treats spawn packets as placement templates.

The installed game yielded 141 stashes. The export classifies 131 as
unconditional, with 683 positions across the original maps. Three stashes have
script conditions and seven have mismatched counts. The exporter keeps these
out of the shared import and preserves their source values for review. The
unusual authored probability of 15 in Zaton stash 22 is exported as guaranteed,
matching the original Lua roll, with 15 retained as provenance. Explicit quest flags, story IDs, story
names and per-object script data are recorded as exclusion reasons for loose items.

The optimized real-map server imported 226 positions in 52 Zaton stashes with
an eight-item cap per stash. Schema v9 records the import and each authored
position. A restart kept the remaining item IDs and state and left a depleted
fixture slot empty. A changed manifest was refused against the seeded database.
[Server acceptance record](acceptance/authored-loot-bootstrap.json).
Schema v10 records the next refill deadline in the same transaction as pickup.
The worker uses recent server player positions, including horizontal proximity
across floors, to defer refill while players are near. A pass attempts at most
one item per stash and eight stashes overall. It preserves the configured cap
and original chance per slot. The dev interval is 15 minutes and the exclusion
radius is 100 metres, plus a 1.5-metre margin for movement during sampling.

An optimized real-map restart drill preserved the deadline and the replacement
ID. Two authenticated WebRTC peers discovered the same SVD at Zaton stash 18
and raced for it. One won. The slot stayed empty past the test's five-second
cooldown while players were near, then refilled after both disconnected. The
winner kept the original on reconnect. A native Chrome session picked up the
replacement with Use and equipped that exact ID in the original inventory.
[Refill and browser evidence](acceptance/authored-loot-refill.json).

Two rendered Chrome clients then emptied the same stock Zaton stash with the
original Use key. A Rust restart kept both empty slots and their deadlines.
The stash stayed empty after both deadlines while either player was nearby.
After both walked away, one stock SVD refilled the stash and the other due slot
stayed empty at the configured cap of one. A second restart kept the refill,
the original ammunition in the first player's inventory, and the depleted
one-time loose placement. [Two-player refill evidence](acceptance/native-stash-refill.json).

One-time loose loot is opt-in through `ZONE_LOOSE_LOOT`. Generate it with
`node server/tools/export-loose-loot.mjs GAME_DIR ITEM_CATALOG AUTHORED_LOOT APPROVAL_JSON OUTPUT_JSON`
and the pinned Zaton development review list
`server/config/loose-loot-development.json`. The list includes 117 positions
without quest flags, story IDs, per-object scripts or references by name in the
campaign configs. Four explosive props remain excluded pending world physics
and damage handling. The exporter uses the original spawn and update packets for
condition, upgrades and loaded or boxed ammunition, plus the original configured
consumable uses. Schema v11 stores loose placements separately from refill slots.
Each position is imported once, and new approvals can add positions without
replacing previously imported items.

In a copy of the schema v10 real-Zaton database, the optimized server imported
all 117 exact coordinates and item states while preserving the existing
equipped SVD. A native Chrome client collected the original 30-round ammunition
box at spawn 1075. After the server restarted the same item was still carried
with 30 rounds and its source was empty.
[Loose loot and restart evidence](acceptance/authored-loose-loot.json).
Two native Chrome engines targeted stock spawn 1183 with the original Use
binding. Both initial-revision commands reached Rust on the same tick,
0.325 ms apart at browser submission. One got the stock 60-round box and it
disappeared for both players. The winner recovered the box after restart and
dropped it through the original inventory menu. The other player used the
original binding to collect it. Its ID, condition and round count stayed the
same through revisions 0 to 3. A second restart restored only the re-looter
as owner and SQLite confirmed the original placement stayed empty.
[Two-engine loot evidence](acceptance/native-loot-race.json)

### Campaign maps and travel

The server can load any one campaign map or run all five in one process.
The maps share a UDP endpoint, player limit and database. Each has its own
simulation, collision, loot and visibility. The session contract binds a map
name, collision and materials to one revision. The unified browser uses it to
select the native level and predictor data. Zaton keeps its deployed revision.
The single-player campaign keeps its own menu and save state.

The private campaign travel export contains ten original level changers,
including their contact volumes, graph destinations, arrival transforms and
serialized gate state. Generate it with
`node server/tools/export-travel-locations.mjs GAME_DIR OUTPUT_JSON`.
Each of the four additional maps has a validated capsule start near an
authored arrival point for local checks. These are development anchors.
All ten records carry an enabled flag in the stock spawn. CoP's
`xr_effects.script` also enables and disables level changers at runtime.
Campaign gates and guide travel still need review before enabling routes.
[Original level-changer state](../src/xrServerEntities/xrServer_Objects_ALife.cpp:766).

An optimized local server joined each map over WebRTC with the original
item catalog. Each map accepted movement, used its own collision and
materials in the staged WASM predictor, and restored the actor position
and six exact item IDs after restart. The server loaded 58, 130, 90, 23
and 6 authored radiation fields for Zaton, Jupiter, Pripyat, Jupiter
Underground and Lab X8 respectively. Zaton, Jupiter and Pripyat seeded 52,
48 and 31 original treasure-manager stashes. The underground areas have
no treasure-manager stashes.

Lab X8 imported 19 reviewed one-time food, ammunition and grenade
placements using `config/loose-loot-labx8-development.json`; all 19 were
still present after restart. The 113 Jupiter Underground loose candidates
all carry campaign-style names and need explicit review. This smoke test
used one server and a disposable save per map. Rendered browser acceptance
and the public rollout remain open.

The server can validate an approved route against the original contact volume
and the destination capsule floor. Approvals are pinned to the spawn hash.
The loader verifies the source collision and bounds, then checks contact
against the server's actor position and posture. A local geometry check
validated all ten authored destination floors using a disposable approval list.
The check established the arrival poses. Each source approach still needs
to reproduce the relevant stock traversal or interaction.

Schema v14 stores the current campaign map and visit number separately from
the saved pose. The handoff transaction records the destination, visit,
condition, combat deadline and idempotent receipt together. It preserves the
life and existing item rows. Session admission and later inventory and
condition operations check the visit. An older visit is stale even after
the character returns to the same map. Authenticated resume returns the
current routing state, including after death clears the pose.

The recovery test injects a receipt write failure and verifies rollback. A
subprocess then exits immediately after a successful commit. Reopening the
database recovers the destination and the original item IDs, and replay
returns the receipt. The old visit can neither save condition nor load a
second actor. This uses the durable boundary from CoP's level change, where
the arrival transform is saved before the destination loads.
[Original ALife level change](../src/xrGame/alife_update_manager.cpp:134).

A stock-map WebRTC drill migrated a copy of a schema-v13 Zaton save. A
trusted test driver used authored route 1012 and exited after committing
the handoff. The old Zaton server rejected admission for the moved
character. The Jupiter server accepted the same save key and restored
life 0, the exact six carried item IDs, 80 health and the authored
arrival position. SQLite retained bleeding and the combat deadline.
The drill switched the server's active map between connections.

A subsequent local test ran all five maps in one optimized server and approved
the stock Zaton-to-Jupiter crossing (1012). A WebRTC client started on the road
outside the crossing and walked into the contact volume. The source server
retired the body, sent the binary travel event, and rejected a stale Zaton
offer. Authenticated discovery sent the same identity to Jupiter without a
server restart. All six item records, the life number and health matched. The
first Jupiter snapshot was within one centimetre of the authored arrival. A
second live client stayed in Zaton and observed only the local body after the
crossing. The approval and spawn used here are local test configuration.

A recovery drill copied a saved character and placed its injured body inside
the Zaton crossing with a combat deadline. Movement during the lock and idle
heartbeats after expiry kept the character in Zaton. A fresh movement input
started travel. The client ignored the travel notice and the server process
was killed after authenticated discovery reported Jupiter. A new process
restored the character in Jupiter with all six items, life 0 and bleeding.

The development policy requires fresh directional input in the approved
contact volume, a living character, and a clear combat lock. Overlapping
approved contacts are ambiguous and leave the actor in the current map.
Outstanding damage and inventory operations settle before travel starts. The browser
restarts the multiplayer engine on the same page after the notice, then
reads the authenticated destination before offering WebRTC again.

The stock underpass controller (`pas_b400_sr_control.ltx`) transitions when
the actor enters `pas_b400_sr_exit` (6208), then moves the actor to level
changer 6303. The export now validates that link and carries the original
restrictor transform and shape. When route 6303 is explicitly approved, the
Rust server uses the restrictor for contact and persists the original Pripyat
arrival directly. The survival approval stands in for the campaign's escort
state. The original single-player sequence remains in the engine.

A local WebRTC client walked from the quarry approach in Jupiter into route
2877. The same server moved the character to Jupiter Underground with the
same six item records and life number. A disposable save set the source
position near the crossing before the test.

The stock underpass exit restrictor overlaps ladder 6146. An optimized WebRTC
test restored a disposable character on the tunnel floor, walked to the
ladder, climbed 15.25 metres and triggered route 6303. The first Pripyat
snapshot used the authored arrival. The same server preserved all six carried
item records and life 0. The test began near the ladder and retained the
character's position from a save using the previous motor revision.

The ladder exporter reads the original `climable_object` records, including zero
thickness and the wooden ladder material. Generate it with
`node server/tools/export-ladders.mjs GAME_DIR OUTPUT_JSON`. The stock pack
contains 45 Zaton, 48 Jupiter, 19 Pripyat, 5 Jupiter Underground and 18 Lab X8
records. The server and WASM predictor share contact, bounded ascent and
descent, and capsule sweeps. Moving into the ladder climbs up and reversing
while attached climbs down. This development control uses CoP's `climb_coef`
of 0.7. The six shallow Jupiter ramps use ordinary collision. Native and WASM
positions matched at all sampled underpass checkpoints, including after an
attached snapshot reset. The rendered controls, animations and approaches to
the other ladders still need playtesting.
[Native ladder contact and bounds](../src/xrGame/ClimableObject.cpp:55).

Lab X8 routes 4422 and 5934 use the original lift buttons and graph arrivals.
The export checks the stock lift scripts, generator restrictor and button
model. The multiplayer Use action sends only a sequence number. The Rust
server resolves the control from the character's position and checks range
and line of sight. It uses the button model's bounds center for the ray because
the Pripyat model's origin sits inside static collision. The browser shows a
prompt near the original control. Loot and container actions keep their native
Use priority.

The rooftop generator is a shared durable state in schema v15. Use in the
authored generator volume turns it on once. The Pripyat lift requires power,
and both lift directions require the original `zat_a23_labx8_key` in the
character's carried inventory. The card is reusable. The handoff checks those
conditions in the same transaction as the destination save. The original
story scripts still run in single player.

An optimized WebRTC drill rejected out-of-range and unpowered Use, started the
generator from a rooftop fixture, and verified that repeat use and a server
restart kept it powered. A visitor without the card remained in Pripyat.
A character with the card used the lift to Lab X8, walked to its button and
returned to Pripyat on the same server. All seven item records and life 0
matched. The temporary starter rules granted the original card, and the drill
placed characters near the Pripyat controls. The rendered prompts and the
normal approach to the rooftop remain to be played. Public access still needs
an acquisition rule for the quest-issued card and an exit policy if the card
is lost inside the lab.
[OpenXRay Lab X8 entrance reproduction](https://github.com/OpenXRay/xray-16/issues/1333).

The full-world gate requires a connected player to reach an approved route
and transition under server authority. The source and destination must
share a durable character record, preserve the life, inventory, condition
and combat state, and recover to one authoritative body after a lost reply
or interrupted browser load. Validate the transfer across all five maps,
including exit from the underground areas and a restart during transit.

### Owned weapon magazines

Reload and Next Ammo use the original key bindings. Unload Magazine uses the
original inventory context menu, including grouped weapons. The server resolves
the carried weapon and compatible boxes, applies the original ammunition order
and upgrade-adjusted capacity, and persists the weapon and box changes together.
The multiplayer item adapter applies saved upgrade sections through the native
item loader before it resolves cartridge indices. The native magazine retains
the authoritative cartridge order and the weapon tooltip resolves the same
upgrade sections from the stock configuration.
Unloading returns the original cartridge types to compatible boxes. The active
slot defaults to the rifle, then the pistol, until the player makes an explicit
selection. The original weapon keys draw either equipped weapon and holster it
when pressed again. The server persists the choice with the character's life.
Removing the selected weapon holsters it. Re-equipping the weapon leaves it
holstered until selected again.

Rust sends the confirmed slot in the reliable vitals event before replying to
a selection. The browser forwards slot changes to the engine worker independently
of its movement snapshots. While a selection is pending, the engine holsters the
previous item and retains one Reload or Next Ammo press for the requested item.
It submits that action after the same item is confirmed for the same life.
Another selection, focus loss, or opening inventory cancels the deferred press.
A Zaton browser run held the engine's selection reply during a Makarov reload
press, then loaded eight rounds after confirmation. An immediate reload after
switching back topped up the Abakan to 30. A second run consumed the Makarov's
last compatible cartridge, removed its empty box and preserved all 12 rounds of
incompatible 9×19 mm ammunition across a server restart.
[Switch and ammunition evidence](acceptance/native-weapon-switch.json)

The original Y binding also queued during the Makarov switch and exchanged
its four FMJ rounds for eight PMM rounds after confirmation. Switching back to
the Abakan and pressing Y exchanged 15 FMJ rounds for 30 AP rounds. The original
reload motions played on both weapons. A restart kept both exact magazines,
item revisions and reserve counts. [Next Ammo evidence](acceptance/native-next-ammo.json).

In Chrome on real Zaton, Reload rejected an empty SVD until the player picked up
the original ten-round box from spawn 714. Reload consumed the box and loaded all
ten rounds into the equipped SVD. Unload returned ten rounds to the inventory.
The final rifle and ammunition states survived a server restart, including the
unrelated 30-round box. [Native SVD evidence](acceptance/native-magazine-cycle.json).
The same engine build loaded the existing single-player campaign save and
accepted movement input. [Campaign screenshot](acceptance/native-magazine-singleplayer.png).

The timing export reads the stock HUD aliases and the OGF and OMF motion files.
Rust verifies the catalog hash, checks coverage for every stock weapon and
selects the stock alias for each reload phase. The export covers 53 weapons,
33 weapon HUDs and 70 aliases. The nine stock hands profiles resolved to the
same timings. A diagnostic optimized browser build matched all 70 durations
to the millisecond using the engine's own motion calculation.
[Reload timing evidence](acceptance/native-magazine-cycle.json)

With `ZONE_RELOAD_TIMINGS`, the live server validates the move in a rolled-back
transaction before sending the stock HUD motion. It binds the reload to the
character's life, active slot and owned item revision. Fire is blocked while
the action is busy. Magazines and launcher rounds commit at the end of the
motion. Holstering during a timed phase cancels the remaining work.

Each timed phase also selects a stock reload sound using the authoritative
weapon state. The first-person client reuses the weapon's sample variants,
authored gain and delay. It keeps a cancellable sound handle across native
item replacement. A normal completion lets the sound finish. Server
cancellation, holstering or leaving first person stops it.

Tube-fed weapons open, commit one shell per insertion, and close when the
magazine is full or the reserve is exhausted. A trigger press during insertion
seats the current shell and closes after the insertion motion ends. Earlier
shells remain committed. The initial request ID retains the first committed
receipt so replaying the request cannot add another shell. Without the timing
export, reload uses the immediate inventory transaction.

In local optimized Chrome, the AK-74 blocked a shot during its 3,035 ms
reload and holstering cancelled a separate reload without a debit. The
SPAS-12 seated its interrupted shell before closing, then reloaded the
remaining two. Restart and replay preserved all four shells and returned
the original receipt. The Groza loaded its VOG-25 without changing the rifle
magazine. A seeded AK-74 jam cleared at the end of the motion without
spending a cartridge.
[Live reload evidence](acceptance/native-magazine-cycle.json)

The first-person sound checks covered magazine reload, jam clear, tube open,
insert and close, the Groza's delayed launcher sample and both TOZ-34 reload
samples. The TOZ-34 used R to top up one chamber and Y to exchange both loaded
buckshot shells for slugs. Restart preserved the loaded slugs and returned
buckshot. The SPAS-12 kept two buckshot shells through an interruption and then
appended two slugs. A forced same-frame shot and reload kept the reload motion
and played both sounds.
[OpenXRay magazine reload](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/WeaponMagazined.cpp#L603)
[OpenXRay shotgun reload](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/WeaponShotgun.cpp#L132-L149)
[OpenXRay launcher sound](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/WeaponMagazinedWGrenade.cpp#L25-L34)
[Reload audio and shell evidence](acceptance/native-magazine-cycle.json#L718)

Two rendered Zaton clients verified a stock upgraded Groza from reload through
drop, pickup, equip and restart. Reload filled its 30-round capacity and left
four rounds in reserve. The original inventory tooltip showed that capacity.
The rifle kept its ID, condition, upgrade, exact cartridge order and loaded
underbarrel round when the second player equipped it. SQLite retained one
copy with the new owner. A converted AK-74 separately showed its stock
5.56 mm ammo types and exact cartridge order.
[Upgraded weapon transfer evidence](acceptance/native-upgraded-weapon-transfer.json)

### Owned weapon firing

The reliable trigger command carries the equipped item ID and the existing aim
sample. The catalog-backed server validates the rewind pose and safe-zone rules,
then commits the cartridge debit and wear on the exact equipped weapon before
publishing the shot outcome. It uses the original multiplayer hit-power entry,
weapon range and RPM, and cartridge power, range and wear coefficients. The
inventory refresh shows the committed state. A shot awaiting persistence cannot
hit a target that has already respawned into another life.

Two optimized native Chrome clients met outside the spawn safe zone on real
Zaton. An empty SVD could not fire. After Reload, a blocked shot consumed one
round and applied wear. Two further rounds hit the other player, reducing health
from 100 to 20 to 0. The server moved all six carried starter items into one
corpse. The shooter opened the original search screen with Use and transferred
the six exact item IDs with Take All. The rifle had seven rounds remaining and
the unrelated 30-round box was intact. After a controlled server restart, the
victim reconnected dead with an empty inventory. Respawn granted six new IDs.
The original six remained in the shooter's rucksack. The same WebAssembly build
also loaded the existing single-player save and passed a shot and reload check.
[Native PvP and single-player evidence](acceptance/native-owned-fire.json).

Owned firearm rounds use the original catalog muzzle speed, cartridge drag,
gravity and range. The server follows the CoP drag and gravity phases along
bounded ray segments. It traces against static cover and the rewound capsule or
NPC bounds, and scales hit power by the remaining speed at contact. The item
worker checks the traced profile against the equipped weapon revision and round
before committing ammunition, wear, and any PvP damage or death together. Each
debit projects the next cartridge's profile for the following shot.
[OpenXRay bullet manager](https://raw.githubusercontent.com/OpenXRay/xray-16/dev/src/xrGame/Level_Bullet_Manager.cpp)
· [IX-Ray trajectory collision changes](https://github.com/ixray-team/ixray-1.6-stcop/blob/default/.github/CHANGELOG.md#L422-L435).

At 94 m on Zaton, the original fire binding spent one Groza cartridge on a low
shot blocked by cover. The straight-ray comparison at that aim hit the calf.
The elevated shot hit the torso and reduced health from 100 to 86. SQLite kept
the remaining eight rounds and both Chrome clients rendered with zero WebGPU
validation errors. [Browser ballistics evidence](acceptance/native-owned-ballistics.json).

Firearm dispersion uses the authored cartridge multiplier, weapon condition,
suppressor coefficient and movement and crouch factors from the original
configuration. Rust samples the original bounded angular distribution on the
server. The TOZ-34 buckshot round traces 15 pellets and a slug traces one. Rust
reserves every affected player and commits one shell debit, sequential pellet
armour wear and one condition update per victim in the same SQLite transaction.
The private A-Life queue admits a shell's eligible native pellet contacts as a
batch. The shooter receives one shot outcome and each victim receives its own
authoritative condition. [OpenXRay firing code](https://raw.githubusercontent.com/OpenXRay/xray-16/dev/src/xrGame/WeaponFire.cpp).

Three rendered Chrome clients exercised a mixed TOZ-34 load on Zaton. A slug
damaged only the aimed-at player. The following buckshot shell reduced that
player to 17 health and killed the adjacent player. The server retained the
survivor's armour wear and a six-item corpse. An injected write failure for
the second victim also rolled back the first victim and the shell debit.
[Browser buckshot evidence](acceptance/native-owned-buckshot.json).

The firearm ray uses the original CFORM triangle and `gamemtl.xr` resistance,
density and ricochet flag. The round continues through zero-resistance surfaces.
Penetration scales remaining speed by cartridge penetration and material
resistance. Leaving a material applies the recorded density loss over its
thickness. The original grazing probability, reflected cone and configured
energy limits control one ricochet per projectile. Each continuation spends the
same range and time budget, with a maximum of 32 surface continuations.
[OpenXRay material hit handling](https://raw.githubusercontent.com/OpenXRay/xray-16/dev/src/xrGame/Level_bullet_manager_firetrace.cpp).

In two rendered Zaton clients, a TOZ-34 fired at the same aim through a stock
glass panel. Buckshot stopped and a slug crossed both faces, taking the target
from 100 to 67 health. A separate grazing shot banked off stock glass and killed
the target. The same fixture hit in 24 of 24 server traces with ricochet enabled
and zero of 24 with it disabled. SQLite retained the round debit and the
seven-item corpse. [Material evidence](acceptance/native-owned-material-cover.json)

The original Aim binding raises the first-person sight. The browser uses the
weapon's stock HUD offsets, idle animation, zoom factor and scope reticle.
The aim bit travels in the existing binary input packet. Rust checks the
selected weapon's identity and zoom configuration, applies the stock walking
restriction and records the raise in its rewind frame. Once the configured
raise time elapses, shots from the same weapon use the stock actor aimed
dispersion while preserving the cartridge and weapon terms. Reloading,
climbing, a weapon or launcher-mode change and stale input clear the raise.
A rendered Zaton run fired the Makarov through its ironsight and the SVD
through its fixed scope. One shot spent one round on each weapon. The SVD
stayed raised when its new ammo revision rebuilt the native HUD item.
[Stock actor accuracy](../src/xrGame/Actor_Weapon.cpp) · [Stock weapon zoom](../src/xrGame/Weapon.cpp) · [Aim evidence](acceptance/native-firearm-aim.json)

Rust applies CoP's turn-speed multiplier to hip-fire dispersion. It measures
the distance between two unit camera directions over elapsed server ticks,
using yaw and pitch from the sequenced input. A reliable shot that arrives
before the corresponding state sample can use the change from the latest
camera direction to its own direction. The measurement uses the server's
input cadence. Fully raised sights still use the stock fixed actor term.
In Chrome on stock Zaton, vertical mouse movement widened the Makarov's hip
cone from 0.02578 to 0.03491 radians. The Abakan accepted successive held
samples and fired nine rounds over an 0.88-second trigger hold. Releasing
the trigger stopped further debits.
[Stock camera velocity](../src/xrGame/ActorCameras.cpp) · [Wire layout](README.md#wire-v3) · [Rendered turn and trigger evidence](acceptance/native-firearm-turn.json)

The current trace resolves against one rewind frame. Time-of-flight against
moving targets, crosshair interpolation,
dynamic-body continuation, ricochet self-hits, animated hit volumes and impact
presentation remain open. Adjustable scope magnification and special scope
vision effects also remain open. Crowded combat throughput remains an acceptance
gate. The private native hit path accepts the same
penetration range as the ammunition catalog, including stock Gauss at 150.

### Fire modes and held triggers

The original Previous and Next Fire Mode bindings default to 9 and 0. They
cycle the weapon's authored selector and show the result in the original HUD
with the loaded ammunition count. An untouched selector uses the last authored
mode. An explicit selection persists on the item, including when it is moved
or the server restarts. The existing zero value continues to represent the
untouched selector in authored loot and saved items.

The server starts a queue on a reliable press for the exact equipped weapon.
Sequenced movement packets carry matching aim samples while the trigger is held.
Release stops the queue. Missing samples expire the queue after nine simulation
ticks, and an old trigger token cannot restart it. The server enforces the
authored queue length, RPM and any two-round or cycle-down cadence. It carries
fractional ticks forward and applies the weapon's separate wear for follow-up
rounds. A jam, empty magazine, death, entering a safe zone or disconnect also
ends the queue. A shot already submitted to persistence can still finish.
Queued follow-up rounds also check the matching trigger lease before submission.

On real Zaton, holding the native Abakan trigger spent one round in single-shot
mode and two in burst mode. The native HUD displayed the selected mode and the
remaining ammunition. A separate WebRTC client fired seven rounds in automatic
mode, stopped on reliable release and verified that the missing-sample timeout
also stopped fire. Replaying the expired token left the magazine unchanged.
[Fire-mode acceptance evidence](acceptance/zaton-fire-modes.json).

The pinned IX-Ray FreeMP client delegates ordinary key press and release to its
inherited gameplay handlers. The browser port likewise keeps CoP's original
selector bindings and HUD while sending trigger state to the Rust simulation.

### Weapon attachments

The original inventory context menu and bag-to-slot drag path submit
attachment actions. The server checks both item revisions, the equipped
weapon, the original attachment class and configuration, installed upgrades,
and occupancy of the scope, silencer or launcher slot. Attaching directly
from a corpse or private locker also checks current access to the container.
Detaching works for carried weapons and uses the actual attached variant.
The browser maps the stock CoP attachment classes to native weapon flags,
selects the fitted scope's original reticle and refreshes addon bones when it
binds the cached first-person HUD model. This keeps the visible model in sync
after fitting, removing or rebuilding the owned weapon.

One transaction moves the loose addon into the weapon's state and records the
request result. The same addon ID, condition and upgrades return to the
rucksack on detach. An authored addon with only a stored section receives
its loose ID on its first detach. The addon follows the weapon through
inventory transfers and corpses. Detaching an underbarrel launcher returns
its loaded grenade and preserves the ordinary magazine.

On the optimized Zaton server, a stock LR300 accepted the SUSAT 1.6,
suppressor and M203, rejected an incompatible PSO and rejected a second
scope. A request replay returned its original result. The three addons
survived restart and detached with the original IDs and conditions. A
separate loaded M203 returned its one grenade and left all four rifle
rounds in place. In Chrome, the original menu fitted and removed all three
items, drew the SUSAT 1.6 reticle while fitted and restored ironsights when
it was removed. A bare Abakan rendered without a scope.
[Transport evidence](acceptance/zaton-attachments.json) · [Rendered attachment evidence](acceptance/native-attachments.json)

The pinned IX-Ray FreeMP persistence code also records the installed
scope, silencer and launcher on the weapon. The survival implementation
retains each owned addon's instance data alongside its installed section.

### First-person weapon models

The multiplayer presentation actor attaches the item from the server-selected
slot to the original OpenXRay HUD. It plays the item's stock draw and idle
motions without running local weapon callbacks. When reconciliation replaces
the native object after a round debit, the HUD reattaches the same owned item
and keeps it drawn. Holstering, third-person view and death clear the HUD.
[OpenXRay player HUD](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/player_hud.cpp)

Each committed firearm round sends a binary cue to the shooter with the
character life, item ID, remaining rounds and launcher flag. The engine plays
the stock firing alias only when the same item is still drawn in first person.
The worker retains one in-flight cue and the latest pending cue, and discards
expired cues after a pause. These motions do not invoke local weapon gameplay.
[OpenXRay firearm motion](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/WeaponMagazined.cpp#L1091)
[OpenXRay launcher motion](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/WeaponMagazinedWGrenade.cpp#L677)

The cue also plays the weapon's stock layered, suppressed or underbarrel shot
sound and its configured muzzle flash and smoke from the HUD muzzle bone.
The audio scene and particle scheduler own the one-shot effects, which can
finish across weapon replacement during ammo reconciliation. Looped presets
emit one pulse and have a one-second cleanup limit. The particle renderer uses
the transformed emitter position for its distance cutoff.
[OpenXRay shot effects](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/WeaponMagazined.cpp#L578)

Optimized Zaton runs verified stock hands with the knife, RGD-5 and AK-74,
three AK-74 firing motions in a held burst, the PM's last-round motion, and
the Groza's underbarrel firing motion. An empty trigger played no firing
motion. The AudioWorklet consumed PCM from the AK-74 burst, suppressed PB and
Groza launcher. A separate held AK-74 burst showed visible muzzle flashes,
sparks and smoke. The same staged build passed the single-player F5/F9 save loop.
First-person reload audio and throw timing, muzzle lighting, casing effects and
jam feedback remain open.
[First-person and magazine evidence](acceptance/native-magazine-cycle.json)

Other players within the same region and the existing 100 m interest radius
receive a binary positional gunshot cue on the unordered, unretransmitted state
channel. It carries the shooter entity ID, the server's rewound firing
position, and the committed weapon section and sound mode. The observer plays
the stock layered, suppressed or launcher sound in world space. The shooter
keeps the separate first-person cue. A state packet carries up to eight shots,
the worker drops cues older than 300 ms, and playback refills an eight-shot
burst allowance at 24 shots per second. These bounds apply only to cosmetic cues.
[OpenXRay stock sound selection](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/WeaponMagazined.cpp#L67-L96)

Two optimized Zaton trials used a shooter and observers about 0.5 m and
275 m away. The nearby observer's AudioWorklet read positional voices at the
firing coordinates for all three AK-74 rounds, the suppressed PB and the Groza
launcher. Neither the shooter nor the distant observer received a positional
gunshot cue. The empty trigger produced no cue. The same unified build passed
single-player F5/F9.
[Observer audio evidence](acceptance/native-observer-gunshots.json)

The observer's living player proxy uses CoP's base actor model or the equipped
outfit's actor visual. A committed shot starts the matching stock upper-body
firing cycle while the proxy keeps its locomotion animation. Repeated rounds
extend the firing cycle. The particle emitter uses the drawn weapon's authored
world muzzle point, or its second point for the underbarrel. The emitter chooses
the normal, suppressed or launcher presets. Audio can still play when the cue
arrives before the matching equipment model or after the proxy moves away from
the recorded origin.
[OpenXRay torso motions](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/ActorAnimation.cpp#L103-L119)
[OpenXRay world muzzle points](https://github.com/OpenXRay/xray-16/blob/dev/src/xrGame/Weapon.cpp#L199-L227)

Two optimized three-client Zaton trials verified the standing AK-74 and PB
motions and the crouched Groza underbarrel motion with the stalker outfit.
The observer submitted stock world-space muzzle sprites. The empty pistol and
the distant observer produced no shot visuals. The clean unified build passed
single-player F5/F9 again.
[Observer presentation evidence](acceptance/native-observer-gunshots.json#L170)

### Underbarrel launcher selection

The original weapon-function binding (V by default) requests rifle or launcher
mode for the equipped item. The multiplayer camera toggle moves to J to free
V for its original action. The binary request carries the desired mode and
the item's revision. The server checks the equipped slot, catalog compatibility
and the installed launcher before it changes the mode. The native presentation uses
CoP's magazine switch to show the selected ammunition without simulating a
local rocket. Reload and unload operate on the selected magazine, preserving
the other magazine and the rifle's fire selector.

On stock Zaton, a WebRTC client switched and loaded an LR300 with an M203 and a
Groza with its built-in launcher. It verified the rejection before mounting
the M203 and received the exact committed reply on replay. Both loaded
grenades and both mode selections survived server restart. Unloading the
Groza and detaching the M203 returned one grenade each and left the rifle
magazines unchanged. The LR300 browser run used V to select the attached
M203, R to load it and Mouse1 to fire. A separate reload and native detach
returned the loaded grenade with the original launcher.
[Launcher selection evidence](acceptance/zaton-launcher-selection.json) · [Rendered attachment evidence](acceptance/native-attachments.json)

### Underbarrel flight and blast

A launcher trigger debits one owned grenade before starting a projectile.
The native trigger sends a single firing intent and uses the original reload
action when the launcher is empty. Firing preserves the rifle's ammunition,
selector, jam state and condition. The server reads the launcher velocity
from the weapon or mounted addon, then reads the fuse, blast power and radius
from the loaded grenade's original projectile definition.

The server advances flight at 30 Hz with X-Ray's gravity and checks each
travel segment against the static map and current actor capsules. A contact
or the fuse detonates the round. The blast uses CoP's distance falloff with
three cover samples per nearby actor. Each sample multiplies the original
static material transmission for every front-facing triangle it crosses. The
existing damage, PvP combat-lock and corpse paths handle the result. Each
round retains its shooter's entity and life for attribution across the delay
between launch and detonation. Pending debits and active projectiles share a
bounded budget. Impact rounds share the existing eight-record, 10 Hz flight
feed with hand grenades and bolts. The browser drew the stock M209 projectile,
then played its original impact particles and positional sound on Zaton.
[Rendered flight evidence](acceptance/native-attachments.json)

On stock Zaton, two WebRTC clients verified one M203 launch at a separation
of five metres. The duplicate trigger sequence spent no second round. The
target's bandage moved to their corpse exactly once. Restart preserved the
death and the shooter's empty launcher, four rifle rounds, selector and
condition. Fixture tests also cover gravity, fuse expiry, static cover and
combat-locked safe-zone entry. [Launcher blast evidence](acceptance/zaton-launcher-blast.json).

Stock Zaton surface probes measured 0% transmission through concrete, 70%
through wood and 90% through glass. Fixture coverage verifies cumulative
attenuation, back-face culling and reduced health damage through a partially
transmitting wall. The rebuilt browser predictor matched the native motor
over 15,000 traversal ticks and 1,000 checkpoints. The four-client Zaton
detonation and restart checks also passed with this server.
[Blast material and movement evidence](acceptance/zaton-blast-materials.json).

The explosion uses static material geometry and actor capsules. Fragment
damage and dynamic-object shielding are open. An in-flight projectile is
transient across restart.
[IX-Ray projectile attribution reference](https://ixray-team.github.io/ixray-1.6-stcop/en/gameplay/general/pda-statistics.html).

### Blast protection and wear

The blast first subtracts the original absorption from equipped belt artefacts.
It then applies outfit and helmet protection in that order. Each piece uses
its authored protection and upgrades, scaled by its current condition.
Each piece wears according to the power it received and its explosion
immunity. Armour wear, residual health and bleeding, and the target's combat
deadline commit in one transaction. A lethal blast also transfers the
carried inventory to a corpse in that transaction.

Pending impacts share the projectile budget and use the target's inventory
queue. The target's life is checked at both database execution and damage
application. Entering safety or disconnecting while an impact is pending
does not cancel an eligible hit. The server decides logout vulnerability
after the hit resolves.

On stock Zaton an M203 blast reached a bystander with about 1.20 hit power.
The military outfit and tactical helmet reduced the residual to about 0.84.
The bystander survived with roughly 15% saved health, and the worn gear
instances, bleeding and combat lock survived restart. The belt test verifies
absorption and that a matching artefact in the rucksack contributes nothing.
[Blast protection evidence](acceptance/zaton-blast-armour.json).

A worker subprocess exited after committing a surviving and a lethal blast
without consuming their replies or checkpointing. Reopening SQLite preserved
both outcomes, including the lethal corpse and its worn gear. An injected
failure during corpse transfer rolled back the damage and wear together.
[Blast crash evidence](acceptance/blast-crash-recovery.json).

Blast-specific stamina, impulse and temporary explosion-immunity effects
remain open.

### Detonation presentation

The server sends the original projectile section and impact position in a
binary control event to peers within 100 metres. Cosmetic delivery has a
limit of eight effects per packet and yields when the control channel backs
up. The browser worker discards effects older than one second and uses
bounded mailbox credit. The multiplayer renderer plays up to eight effects
in a burst and refills its effect budget at four per second.

The native client resolves the section through the original CoP settings and
plays its explosion particle group and positional sound. The stock group
and OGG were verified in the original archives. Four Zaton WebRTC clients
verified that the shooter, victim and a nearby observer each received the
same 57-byte event once. The observer 174 metres away received none. A
server restart produced no old effects. Native playback in a browser,
underbarrel flight visuals, and the explosion light and decals still need
acceptance.
[Detonation presentation evidence](acceptance/zaton-detonation-presentation.json).

### Hand grenades

The grenade slot uses the original F1, RGD-5 and GD-05 items. Fire throws at
the stock quick-throw force. Holding Aim starts the original pin pull and
charges from the stock minimum up to the stock maximum once the hands are ready.
The server measures the charge and launches at the stock throw motion mark.
Cancelling the hold leaves the item untouched. A successful throw consumes
the equipped instance and equips another of the same type if available,
otherwise another compatible grenade or the previous firearm. Schema v17
persists the drawn grenade separately from that firearm selection.
The stock pin pull runs for 1,067 ms, and the release mark starts 369 ms into
the 634 ms throw. The server rounds these waits up to 33 and 12 ticks at 30 Hz.
The renderer plays the original begin, hold and throw aliases and the stock
pin sound. The hands can finish the throw after the equipped item is consumed.
The server still uses the development recovery of 12 ticks after launch.
[Original throw controls](../src/xrGame/Missile.cpp:545),
[IX-Ray grenade replacement](https://github.com/ixray-team/ixray-1.6-stcop/blob/f1188825e86774a488489f043f8aeee9ca4fbfb2/src/xrGame/Grenade.cpp#L230-L332).

Stock hand grenades detonate after 75 simulation ticks at 30 Hz. They bounce
off static surfaces and actor capsules during flight. The GD-05 plays its
original smoke and sound with zero blast damage. The F1 and RGD-5 use the
authoritative blast, cover, armour and death paths. Nearby peers receive
position samples on the state channel. The native renderer uses the stock
grenade models and detonation assets.

Three WebRTC clients on optimized stock Zaton exercised quick and charged
smoke throws, a lethal RGD-5, cancellation, stale item rejection and safe-zone
rejection. The thrower and target received matching detonation positions and
three distinct flight paths. SQLite recovered the target's death and all six
carried items in one corpse. The three spent grenades stayed consumed and the
protected player's F1 stayed equipped after restart.
[Hand grenade evidence](acceptance/zaton-hand-grenades.json).

Two rendered Chrome clients used the original controls to cancel a held GD-05
with the inventory key. Quick and charged smoke travelled at about 25 and
30 m/s in the early samples. Both clients drew the flying models, received
matching detonation positions and consumed the positional smoke sound. The
thrower heard the pin pull. The smoke did no damage. The server selected the
second GD-05 and then the stock RGD-5, and a protected save kept its F1 when
the quick throw was refused. [Rendered grenade evidence](acceptance/native-grenade-presentation.json).

Three rendered clients compared fresh exoskeleton wearers at the same
3.8 m distance from identical RGD-5 and F1 detonation positions. The exposed
target had 78 health after the RGD-5 and 10 after the F1. Both outfits wore,
and the sheltered targets stayed at full health with undamaged outfits.
Each thrower returned to their equipped Makarov after the last grenade. The
thrower and exposed observer consumed positional sound for both explosions.
[Blast comparison](acceptance/native-grenade-presentation.json).

The current bounce uses a sphere and fixed restitution. Stock rigid-body spin,
fragment damage and blast impulse remain open. In-flight grenades expire
with the server process.

### Starter knife

The original knife occupies slot 1. Fire starts a slash and Aim starts a stab.
The stock hands motions both have 21 frames. The slash strikes on tick 8 and
ends on tick 14. The stab strikes on tick 9 and ends on tick 27. Movement
packets can refresh the swing aim through its contact mark. Schema v18
preserves the selected knife alongside existing firearm and grenade choices.

The server verifies the exact equipped instance and traces the rewound pose
against actors and static cover. Both stock attacks use `wound`, so the
stock splash logic picks one victim in either mode. The original radius
loader gives the slash a 0.25 m splash radius and leaves the stab at the
1 m default. The server applies the stock attack power, splash falloff,
artefact absorption, armour protection and wear. It commits health, stamina,
bleeding, combat lock and any corpse transfer together. A swing does not
consume or modify the knife.

Three local WebRTC clients on optimized stock Zaton verified a slash that
started facing away and turned toward the target during wind-up. The target
stayed at 100 health during wind-up, then dropped to 40 health with 94.2%
stamina and 98% outfit condition. An off-centre stab killed the same actor.
Restart preserved the worn outfit and all seven carried items in a single
corpse. The attacker retained the exact knife and selection. Safe-zone
attacks, overlapping swings and use of another player's knife were rejected.
The original smoke and explosive grenade checks also passed on this server.
[Zaton knife evidence](acceptance/zaton-starter-knife.json).

The trace uses capsule contact points in place of animated bone shapes.
A splash stab can apply two scaled contacts to the selected actor when the
first leaves the actor alive. After validating the drawn knife, the server
sends a reliable cue for the stock first-person slash or stab and its recovery.
When the strike resolves it sends the stock knife sound to nearby players. The
attacker hears the HUD sound in first person. Visible actors use the original
standing whole-body or moving torso swing. These animations play without the
native strike callback so Rust retains damage authority. Player hit impulses
remain open.

Two rendered Chrome clients verified the stock slash and stab windups,
recovery motions and the corresponding standing animations. The attacker
heard the HUD sound, and the observer's AudioWorklet consumed three positional
voices at the attacker's location. Both attacks missed at 4.63 m. A close slash
left the armoured target at 15 health with bleeding and a worn outfit, while
an unarmoured target died from one slash. A stab killed the armoured target
and a Rust restart preserved the exact seven-item corpse. A separate pair
verified that stock glass blocked both attacks at 1.12 m and Skadovsk protected
a target 0.92 m away across its boundary. Neither case changed the target's
health, bleeding or outfit condition. A swing from inside Skadovsk was
rejected before the first-person cue.
[Rendered knife evidence](acceptance/native-knife-presentation.json).
[Original knife attack logic](../src/xrGame/WeaponKnife.cpp:225),
[original HUD motion clock](../src/xrGame/HudItem.cpp:184),
[IX-Ray knife motion mark handling](https://github.com/ixray-team/ixray-1.6-stcop/blob/f1188825e86774a488489f043f8aeee9ca4fbfb2/src/xrGame/WeaponKnife.cpp#L342-L426).

### Weapon malfunctions

The server rolls misfire probability before consuming a cartridge. It uses
the weapon's original CoP condition formula and installed upgrade modifiers.
A misfire persists on the exact weapon without spending the round, changing
condition or damaging a target. The server rejects further trigger pulls until
reload clears the jam. A magazine-fed weapon can clear a jam using the loaded
magazine alone. A tri-state shotgun clears the jam when a shell is inserted.
Existing saves and authored placements retain their original representation
until a jam occurs.

The native browser presents the original localized jam warning and sends the
normal Reload action to clear it. A stock AK-74 jammed after eleven successful
shots on Zaton. Its 19 remaining rounds survived the jam and a server restart.
In the native game, the next trigger displayed the warning. Reload cleared
the jam with no reserve FMJ, and the following shot spent one round.
The same WebAssembly binary loaded a copy of an existing single-player
checkpoint, accepted movement and opened the original inventory.
Native jam click and reload sounds remain open.
[Weapon malfunction evidence](acceptance/zaton-weapon-misfire.json).

The pinned IX-Ray FreeMP disconnect path persists weapon condition, ammo and
attachments from the native inventory. Here the Rust item record also
persists the jam so reconnecting preserves the reload requirement.

### PvP armour and wear

Shots use the original multiplayer outfit and helmet rules with the campaign's
gear, ammunition and upgrade definitions. The server selects a representative
CoP bone from the rewound target capsule, then applies the equipped outfit and
helmet in order. Penetration, remaining gear condition and the configured
minimum damage fraction determine health damage and whether the shot opens a
wound. The target's original inventory refreshes when its gear wears.

Ammo debit, gear wear, health, bleeding and the living participants' combat locks
share one SQLite transaction. A lethal hit transfers every carried item to the
corpse in that transaction. The server checks the target's life, campaign visit
and condition revision at commit. It serializes condition and inventory writes
for both participants while the worker resolves the shot. Each player can queue one round,
including a return shot while an incoming hit is in flight. The simulation applies
committed hits to the same target incarnation. Hit regions approximate bones
using the capsule. Animated hit volumes remain open.
[Original cartridge and weapon wear rules](../src/xrGame/WeaponFire.cpp:53).

In the two-client Zaton check, stock AK-74 FMJ took 31 displayed health from an
unarmoured target and 7 from the same target wearing the exoskeleton. Both the
exoskeleton and the battle helmet stopped bleeding from their respective hits,
and their worn condition followed the same items into the corpse. A separate
run equipped the exoskeleton through the original inventory and confirmed the
same reduction and gear wear in the native client.
[Zaton armour evidence](acceptance/zaton-armour.json).

On the optimized server, two WebRTC peers exchanged AK-74 and PM fire on Zaton.
The armoured victim went from 100 displayed health to 76, 52, 28, 4 and 0. The
PM return shot left the survivor at 68. With periodic condition saves disabled
in the test database, a forced process stop and restart preserved both ammunition
debits, the survivor's health, bleeding and combat lock, and all eight victim
items in one corpse. Respawn granted six new IDs once. Replaying its request
returned the same outcome. The corpse and private locker retained their original
items. An injected corpse-transfer failure rolled back the cartridge, armour and
damage writes together. The optimized four-peer launcher test passed, and a
separate AK-74 run verified release, missing-sample timeout and rejection of old
trigger samples. Crowded combat throughput and native UI replay remain acceptance
gates.

IX-Ray FreeMP updates death state in its server kill handler and saves inventory
on disconnect. This implementation applies the server kill after the durable
corpse transaction succeeds. [Pinned FreeMP server](https://github.com/ixray-team/ixray-1.6-stcop/blob/f1188825e86774a488489f043f8aeee9ca4fbfb2/src/xrGame/FreeMP/game_sv_freemp.cpp#L343-L437).

### Private storage

The development station reuses the original Skadovsk player locker from CoP
spawn 51, `zat_a2_actor_treasure`. The native engine renders the original
`inventory_box` and opens the same two-panel search screen with Use. Drag or
double-click to transfer items. Take All and the original store shortcut use the
durable batch journal. The search screen also continues to support corpses.

Each player sees only their own locker contents. Reads, deposits and withdrawals
check the same live character, original take distance and static line of sight.
Items retain their ID and state in storage, including condition and loaded
ammunition. Death transfers carried items only. The existing schema already has
one private storage container per identity.

On the actual lower deck, the owner deposited an equipped SVD and a 30-round
ammunition box by double-clicking. Use stopped opening the locker after walking
away and worked again on return. After the server restarted, a second identity
opened its empty locker at the same location. The owner reopened and withdrew
the same two IDs with Take All. The rifle retained its seven loaded rounds and
condition. A Rust integration test separately covers storage across death and
respawn, denied foreign transfers and the capacity limit.
The same WebAssembly build loaded the existing campaign and opened its original
inventory.
[Native locker evidence](acceptance/native-private-storage.json).

The combined browser check verified third-person Use from the player's eye,
dragging a loaded Groza into the locker and using Ctrl+X to store the remaining
rucksack items. A second identity could open its own locker at the same station,
and Rust rejected a direct request for the other player's locker. Two players
walked beyond the test safe-zone boundary. After the kill and Rust restart,
the dead player rejoined with an empty inventory. The other player took the PM
with a double-click and the remaining five corpse items with Take All. Respawn
granted six new starter items. The owner recovered all five locker items,
including the same Groza, its condition, upgrade, 25 mixed cartridges and
loaded launcher round. The single-player F5 save and F9 reload also passed.
In a separate rendered run with shortened development timers, a ten-item corpse
and a loose rifle kept their contents and absolute deadlines across a Rust
restart. Both expired and disappeared from the observer's game. The dead
player's locker kept its item.
[Full-loss browser evidence](acceptance/native-locker-full-loss.json).

The browser round trip exposed a browser-native timer receiver bug that stopped
periodic discovery and could also stop lost-reply inventory retries. Both timers
now use wrapper calls; regression tests emulate receiver-sensitive browser timer
functions, and Chrome verified discovery advancing repeatedly after the fix.

Revisited the pinned IXRay FreeMP client/server item references for this boundary:
keep original native item objects and acknowledged UI changes, while Rust retains
persistent item IDs and validates interaction range. Native object IDs are only
presentation handles, not durable identity or permission to transfer items.

### Survival and treatments

The server simulates health, bleeding, stamina, hunger, thirst and radiation at
30 Hz. The original actor condition and item definitions supply rates and doses.
The browser applies stamina restrictions to movement prediction and sends item
use through the original inventory menu and quick-use keys. The original HUD
shows bleeding, hunger and radiation. Thirst and stamina are also visible in
the browser's Controls & save panel.

Treatment commits the item spend, the actor condition and the request outcome
in one SQLite transaction. A retry returns the prior outcome. Timed medicine
and boosters resume with their remaining durations on reconnect. Live condition
changes are checkpointed every five seconds and on clean disconnect. A server
process crash can lose condition progress since the last checkpoint. Death and
respawn retain their separate atomic item and life transitions.

Bandages, medkits, food and stamina drinks use CoP's dose rates and timings.
The server currently represents bleeding as one aggregate value. Script-only
consumables remain open.

The local server now applies the original passive health, stamina, satiety,
bleeding and radiation rates from the worn outfit and belted artefacts.
Artefact rates scale with condition. Outfit rates include installed upgrades
and follow the original actor path, which uses the full rate of the worn
outfit. Equipment changes recompute these rates through the inventory
transaction. A restart rebuilds them from the saved item instances and their
placements. The shared condition simulation applies them without inventory
queries in the tick loop.
[Pinned IX-Ray equipment update](https://github.com/ixray-team/ixray-1.6-stcop/blob/f1188825e86774a488489f043f8aeee9ca4fbfb2/src/xrGame/Actor.cpp#L3397).

An optimized Zaton server and WebRTC client verified that the rucksack
artefacts had no effect. A half-condition Fire reduced the bleeding meter from
248 to 236 while raising radiation from 101 to 106 over about four seconds.
Adding a Medusa reversed the radiation trend. The first vitals after a
server restart matched the prior bleeding and radiation readings, and moving
the Fire back to the rucksack removed its effects. This used the browser
binary codec over WebRTC. The native inventory UI needs a retest.

The radiation field exporter reads static radiation shapes and positions from
the original spawn graph. On stock Zaton it extracted 57 spheres and one box
from 39 weak and 19 average fields. The manifest records the source spawn
and item-catalog hashes and stays outside Git. Generate it with
`node server/tools/export-radiation-fields.mjs GAME_DIR ITEM_CATALOG zaton OUTPUT_JSON`.
Select it with `ZONE_RADIATION_FIELDS` on a real-map survival server.
The local server samples the authored geometry every 100 ms using the
authoritative actor capsule and original distance falloff. It applies belt
absorption, worn outfit and helmet ratings, and the stock radioprotector
threshold in order. Gear wear refreshes the condition-adjusted ratings using
the committed inventory generation. Active safe-zone protection prevents
new exposure. The stock outfit and helmet profiles have zero radiation wear.

A local optimized Zaton test used the browser's binary codec over WebRTC.
At field 1477 the radiation meter rose by 62 of 1,000 in about three seconds.
The SEVA suit reduced that gain to 34. Radioprotector held the meter steady,
while antirad lowered it. The saved protector had about 54 seconds remaining
at shutdown. After restart, both treatments continued and exposure resumed
when protection expired. The character walked out of the field and the
radiation meter stopped rising. Native browser presentation and the live
alpha rollout remain open.
[Original radiation field implementation](../src/xrGame/RadioactiveZone.cpp).

In the optimized native Zaton playtest, F2 recovered a queued bandage request
on reconnect, and F1 spent one medkit and restored roughly ten health points.
Double-clicking original inventory items consumed an energy drink and bread.
The remaining stamina boost resumed after a server restart. The same WASM build
loaded the campaign save and opened its original inventory. Simulation tests
cover exhaustion and recovery thresholds. This run preceded the CoP
carrying-weight formulas below.
[Native survival evidence](acceptance/native-survival-treatment.json).

### Continuous acid, heat and psy fields

The `--all` export option adds the authored acid, heat and psy volumes implemented
by the same stock continuous field class. Across the five campaign maps the
export contains 307 radiation, 77 acid, eight heat and 13 psy fields. The Jupiter
export includes the composite acid field at spawn 2842. Single-map deployments
can set `ZONE_ENVIRONMENT_FIELDS`. Campaign regions can set `environmentFields`.
Existing radiation-only manifests still load.

The server applies the original field falloff, belted artefact absorption,
condition-scaled outfit and helmet protection, and active drugs in that order.
Acid and heat reduce health and stamina without a bleeding wound. Psy exposure
also reduces psy health, which recovers at its original rate and appears in the
private Controls & save readout. The original antidote and psy blockade spend
one dose and persist their 60-second protection with the character.

The native HUD and inventory show the stock booster icons from private server
vitals. The update carries which effects are active and which have three
seconds or less remaining. The HUD uses the original blink animation in that
window and clears the icon on expiry.

Ordinary pulses with no gear wear use the cached loadout in the simulation.
Pulses that wear gear or would kill the actor go through the inventory worker.
The worker commits the new condition, exact worn gear revisions and any corpse
transfer together. A test that aborted corpse transfer rolled back the gear and
health changes, then committed them on retry. Safe zones apply the existing
protected-player rule to field contact.

Five WebRTC clients tested the optimized server on Zaton. At acid field 1137,
the unarmoured character lost 13 displayed health points in the same interval
that the worn outfit and respirator reduced the loss to eight. Antidote stopped
the remaining damage while both pieces continued to wear. Heat field 514 dealt
damage and wore the same stock gear types. Psy field 1145 reduced psy health
until the player used blockade. Radioprotector stopped radiation from field
1254. Both cases stayed protected after restart. All three drugs spent one
item despite repeated requests, and four worn gear instances kept their IDs and
condition. All five clients rejoined after the server restarted with all five
maps loaded. The gear wearer could reconnect with a field transaction in flight.
A separate test centered the development safe zone on field 1137 and the
unarmoured character stayed at full health while protected.

Rendered Zaton runs entered all four field types using the stock movement
bindings. Acid damage fell from 20 to 10 health points over equal samples
after equipping an outfit and helmet. Belting Meat Chunk stopped damage, and
unbelting it restored exposure. Antidote held after a clean restart, and a
separate death moved the exact eight carried items into the corpse. The heat
check showed mitigation and gear wear. Psy blockade stopped psy-health loss
and radioprotector stopped radiation buildup. The radiation shield blinked,
cleared at expiry and exposure resumed. [Rendered field evidence](acceptance/native-continuous-fields.json).

The original game uses separate activation rules for mines, fireballs and other
anomalies. Electra activation is covered below. Other reactive hazards, native
psy field post-processing and crowded field throughput remain open.
[Native field pulses](../src/xrGame/RadioactiveZone.cpp:22) ·
[Original field post-processing](../src/xrGame/zone_effector.cpp:59) ·
[Pinned IX-Ray condition rules](https://github.com/ixray-team/ixray-1.6-stcop/blob/f1188825e86774a488489f043f8aeee9ca4fbfb2/src/xrGame/EntityCondition.cpp#L584-L649).

### Bolts and Electra anomalies

Slot 6 draws the original bolt. Fire throws it and holding Aim charges the
throw. The server verifies the carried bolt instance and preserves it after
every throw. Stock force ranges from 10 to 20, with a quick throw at 20
and a ten-second lifetime. The stock model supplies the projectile's
bounding radius. Bolt throws use a 400 ms development recovery. The server
bounds bolt flight separately from grenades.

The `--electra` field export includes 19 Zaton, 39 Jupiter and 29 Pripyat
Electras. The development export selects layer 1 in the stock anomaly
binders. Four Pripyat mines are exclusive to the alternate layer and remain
dormant. The same export includes all original continuous fields.

A bolt or living player touching an Electra starts its 100 ms wake-up.
The server then emits the blowout and applies shock to exposed actors using
the authored falloff and original protection and gear wear. The 100 ms
blowout and 1.5 s recharge follow. A bolt stops activating a mine after
500 ms of continuous contact. Protected players take no damage and the
existing safe-zone rule rejects throws from inside the boundary.
Health, stamina, worn gear and any corpse transfer use the existing
durable environment transaction.

Three WebRTC clients verified the optimized server on stock Zaton. A quick
bolt activated Electra 255 while both nearby actors stayed at full health.
A charged bolt took a separate path and bounced outside the trigger radius.
Walking into the mine produced two further discharges and one seven-item
corpse. The death, exact items, worn outfit, and the thrower's bolt selection
survived restart. The five-map startup and grenade restart regression also
passed. [Electra and bolt evidence](acceptance/zaton-bolts-electra.json).

The unified browser build uses the original bolt mesh, Electra discharge
particle group, positional sound and shadowed flash. The flash uses the stock
color, height, radius, duration and fade. Two rendered clients drew the same
bolt and discharge in Zaton. Their AudioWorklets consumed samples from voices
at the mine's coordinates. Quick and charged throws travelled at about 20 and
18 m/s in this check, respectively. Walking into the recharged mine caused
shock, exoskeleton wear and a seven-item corpse.
[Rendered bolt and Electra evidence](acceptance/native-electra.json).

Projectile bounce approximates rigid-body physics with a sphere. The
first-person throw animation, idle effects, other anomaly families and
emission-driven layer changes remain open.
[Original anomaly state machine](../src/xrGame/CustomZone.cpp:445),
[IX-Ray bolt reference](https://github.com/ixray-team/ixray-1.6-stcop/blob/f1188825e86774a488489f043f8aeee9ca4fbfb2/src/xrGame/Bolt.cpp#L17-L49),
[IX-Ray blowout reference](https://github.com/ixray-team/ixray-1.6-stcop/blob/f1188825e86774a488489f043f8aeee9ca4fbfb2/src/xrGame/MosquitoBald.cpp#L22-L72).

### Detector discovery and authored artefacts

Generate the private manifest with
`node server/tools/export-artefact-sites.mjs GAME_DIR ITEM_CATALOG OUTPUT_JSON`.
Set `ZONE_ARTEFACT_SITES` alongside `ZONE_AUTHORED_LOOT`. One manifest covers
all configured regions. The server verifies its original spawn and item-catalog
hashes, validates patrol coordinates against map collision and pins the import
to the saved world. The exporter found 29 sites across Zaton, Jupiter and
Pripyat, with 84 authored paths and 26 configured starting artefacts. The
Jupiter binder with a zero artefact cap stays disabled.

Schema v20 gives every stocked artefact a persistent inventory instance. The
server samples the stock waypoints, preferring an unoccupied path. It excludes
points without a verified nearby line-of-sight pickup position. The development
simulation uses layer 1, the stock site caps, the stock 17 percent roll and
baseline weights. One refill attempt per site uses the configurable loot
interval and player exclusion distance. Taking an artefact commits ownership
and its refill deadline together. Restart preserves surviving items and
depleted slots.

The detector binding sends a 13-byte binary draw or stow request. Rust checks
the current life, the carried detector in slot 9 and its configured condition
rule. Drawing alongside an incompatible primary tries a compatible pistol,
knife or bolt. Drawing a rifle suppresses detection. Echo exposes a beep cue
and Bear adds bearing. Veles gets nearby points for its radar. Svarog also
receives the stock artefact section for each point so its display can use the
corresponding icon. Detector hints remain private to the requesting player.
Rank, supported sections and ranges come from the stock classes and item
catalog. Items only enter that player's world discovery within the detector's
3–6 metre reveal radius. The five-second window is scoped to the save, life and
map visit. Pickup rechecks the reveal, distance and static line of sight.

Five WebRTC peers on optimized stock Zaton verified the four cue formats, the
five-second reveal after stowing, rejection of a forged pickup, and a single
winner when two players tried to take the same artefact. Restart restored that
exact item to its owner and left the source depleted. A separate five-map run
with a one-second test interval observed weighted refills. The server retained
all 29 sites after excluding 23 individual patrol points without a verified
pickup position. [Zaton detector evidence](acceptance/zaton-detector-artefacts.json)

The browser uses the original detector binding, handheld models and draw and
stow motions. Server hints drive the stock Echo light and beep, Bear direction
display, Veles radar and Svarog artefact screen. In rendered Zaton, Echo kept
Night Star hidden while Veles and Svarog found it. Two players contested a
Crystal within 99 ms. The sole owner recovered it after Rust restarted and
placed it in the first belt cell. A separate Night Star pickup survived a Rust
restart and moved from the rucksack to the first belt cell on a native inventory
double-click. Another fixture confirmed the stock 1%
cutoff for a detector configured to use condition. The unified build passed
the single-player F5/F9 round trip. Eight browser trials verified that the
Crystal appeared just inside each stock 3, 4, 5 and 6 metre reveal radius and
stayed hidden just outside. Echo and Bear's beeps reached the AudioWorklet at
the server's indicated pitch. [Rendered evidence](acceptance/native-detectors.json)

The schema 4 `--electra` export includes zones from Svarog's stock class list
on all five campaign maps. The exporter takes layer 1 from the original
anomaly binders. Rust uses the same bounding-sphere intersection as CoP and
passes each zone's original position and section to Svarog. The private cue
prioritizes artefacts and fills the remaining slots with the nearest zones,
up to 32 total. Regenerate older exports with `--electra` to enable markers.
The optimized server loaded all 521 markers across five maps. In Zaton, two
Chrome clients verified Svarog's stock anomaly icons alongside Night Star,
the range edge and exclusion of an inactive-layer zone. Veles showed only
the artefact and stowing Svarog cleared its cue. [Svarog evidence](acceptance/native-svarog-anomalies.json)

Firearm aiming, timed reloads and ladder attachment pause new detector scans.
The server keeps the detector selected and preserves the current reveal
deadlines. The browser uses the stock fast stow and redraw motions
and resumes detection automatically when the interlock clears. The optimized
Zaton build verified an empty Makarov reload and a climb and strafe exit on
authored ladder 6. Manually stowing while attached left the detector stowed
after the exit until the player pressed O. Timed reload interlocks require
the stock reload timing export. In a separate Zaton run, aiming with the
Makarov let the previous Night Star reveal expire. Releasing Aim redrew
Svarog and revealed it again.
[Reload and ladder evidence](acceptance/native-detector-interlocks.json) · [Aim evidence](acceptance/native-firearm-aim.json)

The geometry seen in the first detector fixture came from viewing a retained
player body at nearly the same coordinates. The shapes cleared on body expiry
while Night Star remained visible and the local camera stayed in place. The
manual plan tracks the overlap under player collision.

Moving artefacts, emission-driven layer changes and detector-load testing
remain open. Reactive families beyond Electra
have authored markers while their gameplay effects remain under G-07. Authored
Veles stashes exist in Jupiter and Pripyat.
Zaton acquisition and progression for all tiers still need decisions.
[Original detector rules](../src/xrGame/CustomDetector.cpp) ·
[Original patrol storage](../src/xrAICore/Navigation/PatrolPath/patrol_path_storage.cpp) ·
[IX-Ray Svarog display and zone scan](https://github.com/ixray-team/ixray-1.6-stcop/blob/default/src/xrGame/EliteDetector.cpp#L241-L301)

### Native A-Life host

The first milestone is a private native Zaton host running the normal
`server(all/single/alife/new)` simulation. The native-only `-zone-alife-probe`
switch captures an atomic one-second snapshot under the host's app-data root.
It records the current level, counts of living online and offline creatures, and
the local runtime NPC IDs, sections, poses and health. Use separate app data for
the host. The stock native `-dedicated` launch path skips AI-space and Lua
initialization, so production headless hosting needs its own startup path that
keeps those systems enabled. [Native AI initialization](../src/xrGame/ai_space.cpp)

The optimized native Apple ARM64 build booted a fresh Zaton campaign with
Cocoa and the stock scripts. Over three seconds of game time, the A-Life
registry went from zero to five living online creatures and from 399 to 451
living offline creatures. The runtime probe captured 11 NPC objects, all
corpses in that opening sequence. Living NPC movement remains unverified.
The macOS offscreen renderer failed at OpenGL initialization, and the localized
new-game autosave filename failed to write. [Native bootstrap evidence](acceptance/native-alife-bootstrap.json)

Launch a native POSIX host with `-zone-alife-headless` to enable the private
player-interest feed and skip window presentation, frame draws and startup input
prompts. Run the normal single-player simulation with the stock scripts and
model data. The renderer still initializes a context to load its resources.
Linux defaults to the SDL offscreen driver and software Mesa. The host samples
AI visibility lighting on demand and uses OpenAL Soft's null output while
retaining in-game sound events. These driver defaults can be overridden in the
environment. In a hidden Cocoa session, optimized macOS ARM64 CoP loaded stock
Zaton, followed both player proxies, and returned an autonomous dog hit over the
private socket. The optimized Ubuntu ARM64 run passed the same test with no
desktop display and with the stock startup input setting enabled. Linux ARM64
uses LuaJIT's built-in allocator to handle PIE heaps outside its 47-bit range.
An optimized x86-64 build passed displayless stock Zaton startup and NPC combat
on a temporary Fly Machine. A subsequent isolated restart loaded a matching
checkpoint and showed mutant movement. The first in-place restart failed its
checkpoint check. [Headless host evidence](acceptance/native-alife-headless.json)

Rust remains the WebRTC and player authority. The native host supplies NPC
spawns, movement, attacks and deaths over a private connection. Rust sends
authorized player poses and accepted hits, applies NPC damage through the
existing equipment and death transactions, and owns any player-accessible
loot. Browser multiplayer renders replicas. Single player keeps its original
local A-Life and campaign saves.

Both `-zone-alife-host` and `-zone-alife-headless` replace the stock
single-actor switch distance check with a bounded set of Rust player positions.
Set `ZONE_ALIFE_INTEREST_SOCKET` in both processes to the same absolute socket
path inside an owner-only directory. The native host binds the socket. Enable
the Rust feed on a persistent campaign with at most 512 player bodies.
In a multi-map campaign, set a distinct `alifeSocket` on each region using a
native host. Each fixed-map process has its own save, outbox and checkpoint
fence. Rust sends the source host an updated player set after travel commits
and sends the destination host the player once they reconnect there.
On a fresh world, the host starts its script actor at the game-graph vertex
nearest the configured anchor. It validates the map on checkpoint restore
and limits offline NPC updates and pathfinding to the assigned level.
NPCs have independent populations on each map. Moving NPCs between maps
would require an explicit ownership transfer.

An optimized local run admitted all five stock maps and persisted each
checkpoint. An approved Zaton-to-Jupiter crossing retained the traveller's
six exact inventory items, life and health. The Zaton observer stayed with
the source host while Jupiter received the traveller. Restarting Jupiter
alone restored its saved checkpoint and left the other hosts running.
[Multi-map A-Life evidence](acceptance/native-alife-campaign.json)
The first admission pins the native world identity in SQLite. Start it with
the native save and outbox that belong to that Rust world.

On startup and after a checkpoint, Rust challenges the host over the private
socket. The native response identifies the map, world lineage, durable
generation, and current process. Rust commits the highest admitted generation
on its persistence worker before replying. A host waits for initial approval
before applying player poses or sending NPC state, and waits for approval of
the latest checkpoint before publishing its corpse transfers or making another
checkpoint. A restarted native process gets a fresh stream identity. Rust
checks it on NPC frames, attack acknowledgements, player hits and corpse
packets. Rust sends complete player snapshots at 10 Hz. Each record includes the
runtime entity ID, life incarnation, position, yaw and stance. A publisher
epoch separates restarts and the native host drops stale ticks within an
epoch. The feed includes authenticated, living, non-travelling players.
Vulnerable logout bodies count while they
remain in the simulation. The native host discards packets for another map and
expires the set after 1.2 seconds without a valid snapshot. The campaign actor
stays available to stock scripts. Each member of a squad can activate or retain
the group using the original online and offline distances.

The optional native `-zone-alife-probe-squads` adds each sampled current-map
squad member's ID, online state and graph vertex to the diagnostic. The first
live split-site run used two grounded Chrome players 661 m apart. A alone
activated three stock squads while B's site stayed offline. Both sites then
activated and the browser clients saw separate NPC sets. When A left, its
squads went offline while B's remained online. A stock snork squad moved
30.48 m between game-graph vertices during that offline interval. A returned
and reactivated the same three squads. The disposable fixture disabled the
60-second logout-body lease to isolate activation. One checkpoint in this run
captured in 146.25 ms with both browser engines running locally. The object
registry now reuses one packet for the full save. In the repeat, the same
activation and progression checks passed. Serialization peaked at 38.88 ms,
and capture peaked at 116.41 ms with 82.53 ms spent preparing client state.
The restored world then ran with both sites active for another minute. The
two periodic captures took 129.55 and 141.15 ms. The slower run used 140.98 ms
of thread CPU, including 103.20 ms preparing client state. This puts the
remaining split-site stall in client-save preparation on the host thread.
In a separate stack sample, 81 of 82 client-save samples were in object save
callbacks. Stalker Lua save callbacks accounted for 64, with 52 in LuaJIT
code allocation. The allocation finding is specific to the sampled macOS
ARM64 build.
The native host now pauses new JIT compilation during object-save callbacks
and restores the previous setting afterwards. The callbacks still run and the
checkpoint format is unchanged. In a two-minute restored split-site run, all
four captures were under 100 ms. The slowest took 92.64 ms, with 32.29 ms of
client-save preparation and 60.27 ms of serialization. This measures the macOS
ARM64 build with two local Chrome engines. On a disposable Frankfurt x86-64
Machine, four captures with the same two sites active ranged from 82.54 to
131.48 ms. Two exceeded 100 ms. Serialization took 105.85 ms in the slowest
capture, and client-save preparation took 69.09 ms in the other over-budget
capture. The x86-64 run used two injected poses and stock NPC scripts.
[Split-site A-Life evidence](acceptance/native-alife-split-squads.json)

The native frame loop polls the bridge before CoP's scheduler runs. It applies
each accepted pose snapshot once and removes its proxies when the feed expires.
Stock A-Life keeps its original scheduler. With 200 synthetic proxies in one
Zaton area, the 30-second sample rose from 108 to 300 NPC updates after moving
socket polling into the frame loop. The p95 update gap fell from 313 to 127 ms.
Checkpoint capture peaked at 73 ms and all proxies were removed after the feed
expired. [Native proxy cadence evidence](acceptance/native-alife-proxy-cadence.json)

A separate local run connected 200 real Chrome WebRTC peers to the optimized
Rust server and native host. Over 40.12 seconds of crowded movement, Rust
averaged 29.96 ticks per second, sustained three native mutants in each
peer's snapshots, committed 780 fixture record writes and had zero stale
clients. Native X-Ray tracked all 200 player proxies. Its slowest checkpoint
capture was 81.26 ms, including 80.85 ms of X-Ray thread CPU. The measurement
used one browser without game rendering and a single crowded safe-zone site.
[Native WebRTC population evidence](acceptance/native-alife-webrtc-population.json)

An optimized local Zaton run admitted two binary WebRTC peers 444 m apart. The
native host received both poses. Four living runtime creatures activated near
the first peer and three moved over one metre, with a maximum displacement of
34 m over 32 seconds. The host dropped both interests after Rust shut down and
the four creatures left the online runtime. The second site had no nearby
living creature in this capture. A separate socket drill verified independent
coverage, the 135 m and 165 m thresholds, stale-feed expiry, and a full
512-position datagram. The full capture used OpenAL at zero volume. A separate
`-nosound` run exposed invalid entries in the stock NPC sound collection. After
filtering failed sound loads, the host reached level synchronization and a
sample showed active rendering. Further A-Life samples in that run are open.
[Activation evidence](acceptance/native-alife-interests.json)

The native host mirrors live player records into stock actor targets with
native IDs. The targets use the original model, sight and faction checks.
Their pose comes from Rust and their physics and condition updates are
disabled. They stay out of the A-Life save, do not bind campaign scripts and
leave the host when their record expires or changes incarnation. The campaign
actor remains available to original Lua and is excluded from ordinary AI
sight. A stock local run in Zaton verified that two WebRTC players each
acquired a native target and both targets expired after the feed stopped. A repeat with
two collision-validated poses confirmed accurate grounded tracking. In a
follow-up run, stock mutants saw and selected both targets and one target
received a native hit. [Target lifecycle evidence](acceptance/native-alife-targets.json)

Rust binds the companion socket with the `.hits` suffix in the same private
directory. The native actor proxy reports hits from stock NPCs on that socket.
Each report carries the last pose tick, publisher epoch, runtime player ID,
incarnation, hit type and power. Bullets include the original bone name and
penetration. Rust checks the sender pathname, the snapshot age and the living
player's current incarnation and safe-zone status. Protected bodies take no
damage. PvE hits do not start a PvP combat lock. Native and server queues are
bounded, and the native host retries transient socket backpressure while the
pose feed remains fresh.

Wounds, strikes, bullets and explosions use the existing persistent impact
transaction. NPC-origin heat, shock, acid, radiation and psy effects use the
existing field transaction. Rust owns the resulting condition, gear wear and
corpse transfer. Browser peers receive updated player health on the usual state
channel. The native host reports NPC-origin damage. Rust continues to own map
anomalies.
[Stock NPC hit generation](../src/xrGame/ai/monsters/basemonster/base_monster_feel.cpp) ·
[Stock actor condition](../src/xrGame/EntityCondition.cpp)

In optimized loopback Zaton, both peers saw a stock dog's hit take a player
from 100 to 55 health and SQLite saved the wound. Six native hits on a player
inside the safe zone left health and condition revision unchanged. A scratch
script sent two native hit events from a living dog and both peers saw health
reach zero. The same transaction moved all six carried starter items to the
corpse. [Native damage evidence](acceptance/native-alife-damage.json)

The `.npcs` socket carries complete, bounded rosters of up to 512 online native
creatures at 10 Hz. Rust applies a roster only after all parts arrive. The host
generation, native ID and spawn frame identify each creature instance and map
to a stable Rust ID while it is online. The server
expires the roster after 1.2 seconds without a fresh complete sample. Player
interest filtering remains on Rust, so clients receive only nearby NPCs.
Positions, health and the primary stock animation travel on the state channel.
The reliable lifecycle channel supplies the creature's stock mesh path. Browser
clients render those models and replay the sampled animation without running a
second AI simulation. Full animation blending, ragdoll poses, NPC weapons and
attack effects remain open.

Rust checks player fire and knife contacts against rewound native model bounds
and static cover. It forwards accepted contacts after the owned action commits.
Grenade flight checks native model bounds for timed bounces and contact
detonation. Blast contacts follow the existing cover rules. The native host
validates the shooter and creature instances, queries the current skeleton for
the contact bone, and applies the original hit handler. A private acknowledgement
returns native health for the existing shot result, and the roster sends health
to every interested peer. A confirmed death stays visible for one second if the
host immediately retires the NPC. Retries reuse the same sequence so the host
applies a hit at most once during its replay window. An unacknowledged shot
expires as a miss and its committed ammunition debit stands.

The optimized Rust server and native host passed a rendered stock Gauss shot
at 150 penetration. One original Mouse1 press spent the single loaded round
and killed a stock stalker. Two Chrome clients received the same death on the
same tick, and the empty rifle persisted in SQLite. A separate rendered TOZ-34
buckshot trial acknowledged the first pellet at 91 health. Both browsers then
received the same snapshot at 6 health after further pellets applied. SQLite
preserved a single shell debit. [Native firearm evidence](acceptance/native-alife-player-attacks.json)

Two optimized Chrome clients received a moving stock red dog under the same
Rust entity ID, with its stock model and primary animation. Both clients removed
the replicas after the native host stopped. The unified build also loaded
single-player Zaton from the existing browser cache. Full pursuit and attack
presentation remain to be checked in both foreground clients.
[Native replica evidence](acceptance/native-alife-replicas.json)

In a subsequent two-client run, two AK-74 rounds took the same red dog to 64
and then zero health under native A-Life authority. Both Chrome clients
received zero for the same NPC in the same state tick. SQLite retained ten of
the original twelve rounds after the server exited. The run used a disposable
safe-zone anchor to keep the observer alive while the two engines started.
[Native player-attack evidence](acceptance/native-alife-player-attacks.json)

Two Chrome clients received the same stock stalker health after a slash and
saw a second stalker take RGD-5 blast damage. With native grenade collision
bounds enabled, the clients received the same stab kill and a separate RGD-5
kill. The protected observer kept full health in both runs. SQLite retained
the replacement grenade in the original slot and imported both corpses from
the second run. Those trials drove the browser WebRTC API. Subsequent rendered
trials used the original knife and grenade slot keys and alternate fire. Both
clients saw the same stalker die from a stab. Both received the same RGD-5
detonation and saw its target drop from 100 to 30 health. The protected observer
stayed at full health. The wasm64 ABI check exercises both knife modes and all
three grenade phases. First-person attack animation and positional audio remain
open.
[Native close-combat evidence](acceptance/native-alife-close-combat.json)

Simultaneous online maps
require a single ownership handoff when squads cross maps. Keep campaign-only
triggers and quest rewards out of shared loot.
Stock boar and flesh have no repeatable corpse inventory. For ordinary armed
stalkers, CoP's death callback runs its Lua loot manager before the native host
reads the remaining items. The host excludes story actors and quest items. It
captures item condition, loaded rounds, upgrades, attached sections, remaining
consumable uses and partial ammunition boxes. An accepted capture removes the
transferred items from native ownership and queues the inventory for Rust.
The persistence worker validates each item against the stock catalog and
commits the reviewed contents through the same searchable corpse container
used for player loot. A short walkable-floor check raises ragdoll roots that
settle below nearby terrain so the usual loot sight ray can reach the anchor.
A two-engine stock Zaton run opened a gameplay-killed stalker's corpse with
Use and transferred all 11 items with the original Take All shortcut. The
other player received none. After Rust restarted, a rendered reconnect
and a SQLite read confirmed the same owner, IDs and item state. In a later
two-menu race, both players sent Take All for all 11 items within the same
measured browser millisecond. Rust gave six items to one player and five to
the other. Both menus reconciled to empty, and both inventories survived
restart with the same item state. Single-item UI contention remains open.
[Armed NPC loot evidence](acceptance/native-alife-corpse.json)

A death record in the same SQLite transaction prevents replays from minting new
items. Before releasing the original items, the host writes and syncs a record
in its private outbox. The outbox defaults to `zone-alife-outbox` under host
app data. `ZONE_ALIFE_OUTBOX_DIR` can name an absolute path on persistent
storage. Keep the directory with its native world and Rust database across
restarts. The host reloads pending records with their original death IDs and
retires them after Rust acknowledges the SQLite commit.

In either native host mode, X-Ray writes the stock save format to
`savedgames/zone-alife-world.scop` under its app data. It saves periodically
and brings forward the next save when corpse transfers are staged. X-Ray
captures the stock simulation state on its main thread, then a background
worker compresses and writes the save and outbox. The compressed save includes
the IDs of staged and unacknowledged transfers. The worker syncs and replaces
the save before advancing the generation in the outbox's `world-fence` file.
Rust receives staged transfers over the private socket after both writes
succeed. Acknowledged outbox files are removed during background persistence.
Startup automatically loads the latest save. It rejects an
older standalone save when its generation or world identity differs from the
fence. A previously unfenced outbox must finish pending transfers before
migration. Keep the save, fence, and outbox together on persistent storage.
If both native files are restored together, Rust still checks their lineage
and generation against its newer database. It withholds player poses and
declines gameplay traffic from a rejected process. Every corpse import
rechecks the accepted generation in the SQLite ownership transaction. Native
recovery keeps outbox files on disk until the restored generation is admitted.

The stock Zaton drill committed an armed stalker's 11-item corpse at native
generation 2. After Rust restarted, generation 1 loaded locally with its
original fence but received no player poses from Rust. The newer journal
survived the attempt. Generation 2 resumed the bridge and replayed the same
death. SQLite retained one corpse and the exact item IDs and state.
The displayless x86-64 repeat on a disposable Fly Machine also rejected the
older pair. It resumed the current world in place after restarting Rust and
replayed a deliberately unacknowledged transfer. SQLite kept one corpse and
the same 11 items.
[World admission evidence](acceptance/native-alife-world-admission.json)

The optimized ARM64 Linux host loaded its checkpoint in place and replayed the
identical 12-item corpse packet. The earlier macOS restart imported one corpse
and all 12 items into Rust. A current host rejected a genuine older save
paired with its newer fence. In the stock Zaton timing fixtures, simulation
capture peaked at 99.3 ms. The Linux harness added 250 ms to each background
file sync. NPC updates continued through 1.0–1.5 seconds of worker I/O in
steady state. Capture time and update cadence at target population remain
open. [Checkpoint evidence](acceptance/native-alife-checkpoint.json)

The native crash drill captured stock Zaton loot, killed the host before Rust
received it, and recovered the record on the same socket once the old process
released its lock. Rust imported one corpse and all eleven items. Replaying
the exact record after that commit preserved the item IDs and state.
[Native loot recovery evidence](acceptance/native-alife-outbox.json)

Two optimized Chrome clients searched the same stock 11-item corpse and
contested an LR-300. One took it. After a Rust restart the winner still had
the same rifle at 57% condition with 30 loaded rounds, and the corpse held the
other ten items. The run drove the standard WebRTC actions from the test
harness. Manual inventory presentation and native host restart remain open.
[Armed NPC corpse evidence](acceptance/native-alife-corpse.json)

IX-Ray integrates native A-Life in FreeMP. The GAMMA multiplayer project keeps
one game's host simulation authoritative. The private death handoff follows
the same single-simulation boundary while Rust owns browser-player loot.
[Original object switching](../src/xrGame/alife_dynamic_object.cpp) ·
[Original squad switching](../src/xrGame/alife_online_offline_group.cpp) ·
[Original death event](../src/xrGame/game_sv_single.cpp) ·
[IX-Ray multiplayer A-Life](https://github.com/ixray-team/ixray-1.6-stcop/blob/default/.github/CHANGELOG.md#L2654-L2662) ·
[GAMMA host and client split](https://github.com/JonahFSD/stalker-gamma-online/blob/main/SETUP_GUIDE.md#architecture-how-it-works)

### Carrying weight

The server totals the actual items in the carried container, including worn
equipment, partial boxes, loaded cartridges, attachments, upgrades and
condition-based consumable portions. Load changes accompany committed inventory
actions. The firing transaction returns the mass of the spent round. Login and
offline-body recovery rebuild the load from persisted items.

The stock catalog sets the carrying threshold at 50 kg and the movement limit
at 60 kg. Above 50 kg, the CoP formulas increase stamina costs. Above 60 kg,
directional movement stops and pickups still work. Worn outfits raise both
limits and apply their stamina multiplier and sprint restriction. Belted weight
artefacts scale their bonus by condition. Hercules raises both limits by 20 kg
for its original five-minute duration. Movement prediction, the original
inventory weight display and the overweight HUD indicator use the server's
values.

The stock LTX spells standing recovery as `-0.001.1`. The original C++ reader
uses `atof`, which reads this as `-0.001`. The server uses the same value.

The server uses the selected weapon's original `sprint_allowed` value with
the outfit, stamina and weight rules. Private vitals carry the drawn slot and
sprint eligibility for the original HUD and the browser predictor. The firing
transaction verifies the requested item is in the drawn slot before spending
any ammunition. Weapon selection is bound to the current life and saved in
schema v16. [Original inventory sprint gate](../src/xrGame/Actor_Network.cpp:2078).

An optimized local Zaton WebRTC test held Sprint and measured 4.00 m/s with the
stock PKM drawn and 6.00 m/s after drawing the stock PM. The server rejected a
selection for the wrong life, a shot from the inactive PKM and a shot from the
holstered PM. The one accepted pistol shot spent exactly one cartridge. After
restart, the PKM was still drawn and restricted sprinting. Moving it to the
rucksack and equipping it again left it holstered. The test provisioned both
original weapons in a disposable save. The staged browser build includes the
native selection keys and HUD wiring, and rendered acceptance is open.

On original Zaton collision, a 67.7 kg character held position and could still
pick up a dropped bandage. Equipping the stock exoskeleton restored movement
and raised the carrying threshold to 80 kg. A half-condition Goldfish raised
it to 86 kg, and Hercules raised it to 106 kg. The native inventory accepted all
three actions and displayed the new thresholds. The native save restored the
equipped gear and active boost after a server restart. The limit returned to
86 kg when the boost expired with the inventory open. After removing the outfit,
the original HUD showed its red overweight indicator. Dropping two PKMs through
the original context menu brought the load down to 52.7 kg, and a three-second
sprint lowered stamina from 100% to 85%. The same inventory build loaded an
existing campaign save and showed its own 18.3 kg load and 50 kg threshold.
[Zaton carrying-weight evidence](acceptance/zaton-carrying-weight.json).

The unified browser follows the original CoP action bindings. The default X
toggles sprint, Shift walks and Ctrl crouches. The shared Rust motor and
browser predictor distinguish walking from ordinary movement and sprinting.
The rendered replay measured about 2, 4 and 6 m/s respectively. The PKM pickup
increased the sprint stamina cost above 50 kg. The exoskeleton pickup took the
load above 60 kg and blocked movement until it was equipped. F1 through F4 each
spent one assigned dose. The active stamina and weight boosts survived a clean
restart. In the full-duration run the original inventory displayed the limit
returning from 106 kg to 86 kg on expiry.
[Combined survival evidence](acceptance/native-survival-loop.json).

### Visible player equipment

The server derives the outfit, helmet and drawn firearm section names from the
same committed inventory state as movement and armour. It sends them in bounded
binary visibility updates when a living player enters range or changes equipment.
The public descriptor carries no item IDs, ammunition, condition, upgrades or
rucksack contents. Transform snapshots still control actor membership.
[Zone's reliable area-of-interest messages](https://github.com/AnarchadiaMC/Zone/blob/1eb99802b41e525f3896d710dee881f67c7e8fa9/zone-server/internal/game/aoi_manager.go#L221-L294).

An optimized local Zaton run used three real WebRTC clients. A nearby observer
received the stock outfit, tactical helmet and drawn PKM, then received updates
for the switch to the PM, holstering, helmet stow, redraw and departure. The
out-of-range client received neither the actor nor their gear. After restart
the observer received the outfit and drawn PM. SQLite retained the stowed
helmet in the rucksack.

The optimized unified engine includes the native proxy presentation and uses
the original outfit actor model and held weapon hand transform. Archive checks
resolved the models for 12 outfit, eight helmet and 53 firearm sections in the
original survival catalog. All 11 distinct outfit models have the head and hand
bones used by the proxy. The stock helmet world mesh uses an upright head
anchor. Three rendered browsers verified the stock Stalker outfit, tactical
helmet and AK-74. The nearby observer saw each equipment change in 39–112 ms
on loopback, including holstering and stowing. The distant observer received
the same actor at 97.6 m, removed it at 101.7 m and received its current outfit
when it returned. The public descriptor carried only model and appearance
metadata. SQLite retained the equipped outfit, stowed helmet and holstered
rifle after the run.

The replay exposed the opposite yaw sign used by the X-Ray heading transform.
The browser converts Rust player yaw at the model transform and native A-Life
applies the same conversion to its player proxies. Native NPC poses already
carry X-Ray heading. The observer saw the corrected eastward walk, the stock
firing torso animation and an AK-74 muzzle 0.81 m ahead of the east-facing
actor. The drawn weapon now carries a visibility mask for its stock scope,
launcher and suppressor bones. The observer updates those bones on the
existing world model when the owner fits or removes a part. A two-browser
Zaton run verified each change, holstering, redraw and a reconnecting
observer's initial view. Rendering slung weapons remains open.
[Rendered attachment evidence](acceptance/native-remote-addons.json) ·
[Rendered equipment evidence](acceptance/native-equipment-visibility.json) ·
[Original weapon transform](../src/xrGame/Weapon.cpp:141),
[original outfit model selection](../src/xrGame/CustomOutfit.cpp:309).

### Safe-zone combat entry

Skadovsk, Yanov and the Pripyat laundromat use the stock no-weapon restrictor
volumes from `all.spawn`. Rust loads each export only with its matching CFORM
hash and uses the authoritative actor feet for membership. The development rule
keeps these three hubs active throughout a multiplayer session. Campaign alarm
and quest conditions are separate single-player behavior. Maps without a
reviewed matching export use the development spawn sphere.
[Authored hub export](config/cop-safe-zones.json) ·
[OpenXRay restrictor geometry](https://raw.githubusercontent.com/OpenXRay/xray-16/dev/src/xrGame/space_restrictor.cpp) ·
[Zone's server-side safe-zone rules](https://github.com/AnarchadiaMC/Zone)

A damaging PvP hit starts or refreshes the configured combat lock for both
players. A locked player remains vulnerable after entering the safe zone.
Players inside the boundary cannot fire. The server checks protection at both
the rewound hit pose and the current pose. The snapshot protection flag follows
the resulting state, and protection returns when the timer expires.

The simulation test covers crossing the boundary, taking a second hit, the
weapon restriction inside the zone, and protection after expiry with a rewound
shot. Two rendered Chrome clients tested the stock Skadovsk boundary with the
original movement and fire bindings. A PM hit lowered the defender to 78 outside,
then to 55 inside while locked. The defender could not fire or spend a round
inside. After lock expiry the next shot left health at 55, and protected logout
removed the body in 210 ms in that run.

### Vulnerable logout

On disconnect, the server releases the transport and clears the actor's input.
An unprotected living actor remains visible and vulnerable until the logout
timer runs out. It continues taking survival damage and can leave a normal
lootable corpse. Rejoining during the timer takes control of the same actor.
Protected characters can leave immediately. Both paths save the character's
position, facing, posture and condition for the next join. The same configured
capacity bounds connected sessions and retained bodies.

The position checkpoint is bound to the world and collision revision. Logout and
combat-lock deadlines are stored as wall-clock times, so a clean server restart
restores active bodies with their remaining timers. Live combat hits and
disconnects trigger an early checkpoint. An abrupt process crash can lose
simulation changes that were still queued. A silent transport drop is detected
by the server's 20-second input timeout before the logout timer starts.

IXRay FreeMP's disconnect handler saves actor position and condition along with
inventory. Here the Rust simulation keeps the actor live through the exposure
window and commits death and inventory changes together. Two Chrome gameplay
clients verified same-body rejoin, timer expiry and a kill after crossing into
the safe zone and disconnecting. A second run restarted the server while the
wounded body was still offline and killed it after recovery. The native game
opened that dead life with an empty inventory and respawned with six new items.
[Zaton logout evidence](acceptance/zaton-vulnerable-logout.json).

The current two-engine recheck at the stock boundary reclaimed the same
unprotected body after reconnect and observed a second living body expire after
55 seconds. Rust restored an unprotected offline body after a clean restart.
The attacker killed it, SQLite retained an eight-item corpse, and the defender
reopened the empty dead life and used Enter to respawn with six items. The
browser now waits for its authoritative actor before sending input. Its first
neutral input and native first-person view use the saved heading and crouch.
Two rendered clients verified protected reconnect, vulnerable same-body
reconnect, and pose restoration after a clean restart. The same optimized
binary passed the original single-player F5 and F9 save round trip.
[Rendered recheck](acceptance/zaton-vulnerable-logout.json)

Current validation covers parser semantics, cross-language binary codecs,
transaction races, rollback/restart, authenticated worker requests, equipment
rules, starter grants, expiry and browser journal recovery. Two real browser
WebRTC clients passed pickup contention, equip/drop/re-loot, full-loss death,
reconnect and respawn on the optimized server. A server restart preserved both
identities, life counters and exact item IDs/equipment/state. Regression tests
also verify that replaying a lost respawn reply after a later death cannot restore
the character or mint another kit. Original engine UI and broader gameplay
acceptance remain open; this test used a transport harness and fixture combat.

Next dependencies:

1. Complete the actor-backed multiplayer adapter acceptance: equip/belt,
   drag-and-drop, stacked-item actions, pickup and corpse search, two real engine
   clients, death/reconnect and restart. Native actor/item presentation and a
   single-item menu Drop and rifle placement now work. Full weapon/actor gameplay adaptation remains
   incomplete (`actorAdapter:false`). Keep unified menu/build and SP isolation.
   Real-map corpse search, Take All, same-item contention and two-player stash
   refill passed. The combined helmet, mixed-state stack and interrupted
   Drop All run passed on the optimized unified build.
   ToSlot/ToBelt fallback, exact belt cells and grenade equip are now routed. No local-use fallback is allowed.
2. Finish original consumable effects, weapon/ammo/attachment behavior and
   remaining authored loot classification.
3. Extend survival to the remaining equipment, protection and environment
   effects, then complete the remaining mechanics acceptance checks through the
   engine UI.

## Configurable development defaults

The user authorized development defaults on 2026-11-08. They live in
`config/survival-development.json`; `ZONE_SURVIVAL_RULES` selects an override.
These are initial test values, not final balance:

- Starter kit per life: knife, bolt, PDA, torch, one bandage, one bread,
  an equipped PM pistol and AK-74, and one full box of ammo for each weapon.
  All ten items are lost on death.
- Respawn delay: 10 seconds; corpse lifetime: 30 minutes; dropped items: 15 minutes.
- Loot refill interval: 15 minutes; exclusion radius: 100 m; cap: eight items per
  authored spawn. The stash replenishment pass uses these values.
- Private locker limit: 128 item instances. The location and limit can be
  overridden in the survival rules.
- Thirst drains 0.02 points per second. At zero thirst the actor loses 0.1
  points of health per second outside protected zones. An energy drink restores
  35 points of thirst in addition to its original stamina effect.
- Safe-zone combat lock: 60 seconds from the latest damaging PvP hit.
- Vulnerable logout: 60 seconds after the server detects an unprotected disconnect.

## Decisions still required

Development defaults above are authorized. Remaining decisions/refinements:

- Treatment/classification of quest and story-dependent loot.
- Tune the configured timers and starter kit after playable testing.
- Balance private-storage limits and choose whether the current Zaton spawn,
  which lies outside Skadovsk's stock boundary, should move into the hub.
- Tune the implemented logout and combat-lock policy after multiplayer playtests.
- Hunger, thirst and bleeding rates, and the detailed PvE design.

## Existing implementation references

- [Inventory.cpp](../src/xrGame/Inventory.cpp): pickup, rucksack, equipment and belt rules.
- [ActorCondition.cpp](../src/xrGame/ActorCondition.cpp): weight and movement restrictions.
- [UIActorMenuInventory.cpp](../src/xrGame/ui/UIActorMenuInventory.cpp): existing inventory interactions.
- [UIActorMenuDeadBodySearch.cpp](../src/xrGame/ui/UIActorMenuDeadBodySearch.cpp): corpse/container presentation.
- [WeaponMagazined.cpp](../src/xrGame/WeaponMagazined.cpp): ammunition, reload/unload and attachment behaviour.
- [Weapon.cpp](../src/xrGame/Weapon.cpp), [WeaponUpgrade.cpp](../src/xrGame/WeaponUpgrade.cpp) and [WeaponShotgun.cpp](../src/xrGame/WeaponShotgun.cpp) define condition-dependent jams, upgrade modifiers and clearing through reload.
- [ShootingObject.cpp](../src/xrGame/ShootingObject.cpp) and [WeaponFire.cpp](../src/xrGame/WeaponFire.cpp) define multiplayer hit power and cartridge-dependent weapon wear.
- [CustomOutfit.cpp](../src/xrGame/CustomOutfit.cpp), [ActorHelmet.cpp](../src/xrGame/ActorHelmet.cpp) and [BoneProtections.cpp](../src/xrGame/BoneProtections.cpp) define armour protection and wear.
- [Explosive.cpp](../src/xrGame/Explosive.cpp) and [GameMtlLib.cpp](../src/xrMaterialSystem/GameMtlLib.cpp) define blast attenuation and the original material factors.
