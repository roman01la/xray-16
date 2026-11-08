# STALKER multiplayer survival mechanics

Agreed mechanics for the first playable survival release. Call of Pripyat's
single-player inventory, item definitions and weapon behaviour are the reference.
The multiplayer server owns shared world state and durable changes. Existing
combat and NPC fixtures demonstrate integration, not completed gameplay.

The core loop is to leave a safe zone, scavenge, fight or avoid threats, return
with supplies, and prepare for another trip. Target population remains 100–200
players; outstanding capacity and recovery gates are tracked in [PLAN.md](PLAN.md).

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

PvE enemies participate in the same authoritative damage and loot systems. Their
behaviour, population, spawning and simulation budgets require a separate design;
the stationary NPC fixture is not a finished PvE system.

## Authority and persistence

Players use a portable save key stored locally; the server stores its credential
hash and stable identity. Copy/import restores the same save in another browser.
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
The following code is implemented locally; none of these mechanics changes has
been deployed to the public instance:

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
Contention between two simultaneous native engines and review of unsupported
explosive props remain open.

### Owned weapon magazines

Reload and Next Ammo use the original key bindings. Unload Magazine uses the
original inventory context menu, including grouped weapons. The server resolves
the carried weapon and compatible boxes, applies the original ammunition order
and upgrade-adjusted capacity, and persists the weapon and box changes together.
Unloading returns the original cartridge types to compatible boxes. The active
slot defaults to the rifle, then the pistol, until the player selects a slot.

In Chrome on real Zaton, Reload rejected an empty SVD until the player picked up
the original ten-round box from spawn 714. Reload consumed the box and loaded all
ten rounds into the equipped SVD. Unload returned ten rounds to the inventory.
The final rifle and ammunition states survived a server restart, including the
unrelated 30-round box. [Native SVD evidence](acceptance/native-magazine-cycle.json).
The same engine build loaded the existing single-player campaign save and
accepted movement input. [Campaign screenshot](acceptance/native-magazine-singleplayer.png).

This implementation commits reload on input. Tri-state shotguns insert one shell
per request, and launcher ammunition is handled when launcher mode is already
set. Original reload animation timing and native launcher switching remain open.

### Owned weapon firing

The reliable trigger command carries the equipped item ID and the existing aim
sample. The catalog-backed server validates the rewind pose and safe-zone rules,
then commits the last cartridge and its wear on the exact equipped weapon before
resolving damage. It uses the original multiplayer hit-power entry, weapon range
and RPM, and cartridge power, range and wear coefficients. The inventory refresh
shows the committed state. A shot awaiting persistence cannot hit a target that
has already respawned into another life.

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

The current hit model uses hitscan, capsule hits and static occlusion. Original
ballistics, pellet spread, launcher projectiles and native firing effects remain
open. The persistence worker commits each accepted shot. Its throughput under
crowded combat remains an acceptance gate.

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
The presentation object applies the selected scope model and icon settings.

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
rounds in place. The original menu, drag and scope presentation still need
native browser acceptance. [Attachment evidence](acceptance/zaton-attachments.json).

The pinned IX-Ray FreeMP persistence code also records the installed
scope, silencer and launcher on the weapon. The survival implementation
retains each owned addon's instance data alongside its installed section.

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
magazines unchanged. The native binding and HUD need a browser retest.
[Launcher selection evidence](acceptance/zaton-launcher-selection.json).

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
bounded budget.

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
remain open. Firearm damage still uses its separate checkpoint path.

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
flight visuals, and the explosion light and decals still need acceptance.
[Detonation presentation evidence](acceptance/zaton-detonation-presentation.json).

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
Native jam click sounds, reload animation timing and launcher firing remain
open. [Weapon malfunction evidence](acceptance/zaton-weapon-misfire.json).

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

Ammo debit and gear wear share one SQLite transaction. The server checks the
target's life before committing wear and again before applying damage. Health,
bleeding and death still use the simulation and its existing persistence path.
A crash between ammo debit and the health checkpoint can preserve gear wear
while losing the most recent damage. Hit regions approximate bones using the
capsule. Animated hit volumes and environmental armour effects remain open.

In the two-client Zaton check, stock AK-74 FMJ took 31 displayed health from an
unarmoured target and 7 from the same target wearing the exoskeleton. Both the
exoskeleton and the battle helmet stopped bleeding from their respective hits,
and their worn condition followed the same items into the corpse. A separate
run equipped the exoskeleton through the original inventory and confirmed the
same reduction and gear wear in the native client.
[Zaton armour evidence](acceptance/zaton-armour.json).

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
inventory. The native locker check exercised double-click and Take All. Drag
and the store shortcut still need native acceptance.
[Native locker evidence](acceptance/native-private-storage.json).

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
The server currently represents bleeding as one aggregate value. Protection
boosters, script-only consumables and damage from environmental hazards remain
open.

In the optimized native Zaton playtest, F2 recovered a queued bandage request
on reconnect, and F1 spent one medkit and restored roughly ten health points.
Double-clicking original inventory items consumed an energy drink and bread.
The remaining stamina boost resumed after a server restart. The same WASM build
loaded the campaign save and opened its original inventory. Simulation tests
cover exhaustion and recovery thresholds. This run preceded the CoP
carrying-weight formulas below.
[Native survival evidence](acceptance/native-survival-treatment.json).

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
uses `atof`, which reads this as `-0.001`. The server uses the same value. The
active weapon's sprint restriction and the remaining equipment effects are
tracked with weapon and armour parity.

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

### Safe-zone combat entry

A damaging PvP hit starts or refreshes the configured combat lock for both
players. A locked player remains vulnerable after entering the safe zone.
Players inside the boundary cannot fire. The server checks protection at both
the rewound hit pose and the current pose. The snapshot protection flag follows
the resulting state, and protection returns when the timer expires.

The simulation test covers crossing the boundary, taking a second hit, the
weapon restriction inside the zone, and protection after expiry with a rewound
shot. Two Chrome gameplay clients verified the crossing, firing restriction and
damage inside the zone against the optimized server. The native engine client
separately verified reopening the resulting dead save and respawning.

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
   Real-map corpse search, Take All and loose pickup now pass. Verify same-item
   contention between two simultaneous engine clients. Retain native upgrade
   and mixed ammunition presentation.
   ToSlot/ToBelt fallback, exact belt cells and grenade equip are now routed. No local-use fallback is allowed.
2. Finish original consumable effects, weapon/ammo/attachment behavior and
   remaining authored loot classification. Verify death with stored items and
   expiry in the native game.
3. Extend survival to the remaining equipment, protection and environment
   effects, then complete the remaining mechanics acceptance checks through the
   engine UI.

## Configurable development defaults

The user authorized development defaults on 2026-11-08. They live in
`config/survival-development.json`; `ZONE_SURVIVAL_RULES` selects an override.
These are initial test values, not final balance:

- Starter kit per life: knife, bolt, PDA, torch, one bandage and one bread.
  No firearm or protected carried item. All six are lost on death.
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
- Balance private-storage limits and validate safe-zone interaction rules in play.
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
