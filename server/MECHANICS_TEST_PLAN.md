# Multiplayer mechanics manual test plan

This is the living playtest checklist and scope register for the survival alpha.
[MECHANICS.md](MECHANICS.md) defines gameplay and records implementation evidence.
[PLAN.md](PLAN.md#remaining-foundation-acceptance-in-priority-order) tracks capacity,
network endurance, recovery and broader traversal gates.

## Test setup

1. Stage one optimized unified browser build and its matching release server.
   Use the stock asset pack, collision and authored data for the map under test.
   Start on Zaton with a disposable database and separate browser profiles A and B.
   Use C for observer tests. [Unified build](../misc/web/README.md) · [Local server setup](README.md#run-the-isolated-zaton-engine)
2. Start both players from the unified Multiplayer menu. Verify A and B have
   different save identities. Keep a separate single-player save for regression
   checks. Use a spare browser profile when importing A's save key.
3. Use the bindings shown in Settings. Seed rare gear, routes and timed cases in
   the disposable environment as needed. Record the starting positions, fixture
   grants and timer overrides. Run contention in two rendered engines at once.
4. Record the client build, server revision, map, browser/OS/GPU, account roles,
   network conditions and overrides. Repeat the hosted smoke checks separately.
   Keep save keys and private game data out of evidence. [Deployment runbook](deploy/FLY.md)

## Hosted handoff

Open [the unified game](https://stalker-online.xyz/) and choose Multiplayer.
Use separate profiles for contention and save-key import. Start with MP-01,
MP-02, MP-06 and MP-07. The hosted alpha runs native A-Life in Zaton, Jupiter,
Pripyat, Jupiter Underground and Lab X8. Use the hosted game for normal
MP-18 travel and MP-19 NPC observation. Use a disposable local setup for
restart, checkpoint, contention and Lab X8 access-card fixtures. For a hosted
restart check in MP-02, use the next scheduled restart.

## Manual cases

The last column records the scope of existing evidence as of 2026-11-09. A
**Partial** case still has steps to run. **Open** means the stated manual case
needs a result. **Blocked** means the named gameplay is missing. Individual
runs use **Pass**, **Fail**, **Blocked** or **Skipped** with a reason for every
blocked or skipped case. Transport, fixture and build results have their own
evidence scope and do not close a rendered playtest.

| ID | Test and expected result | Evidence and remaining check |
|---|---|---|
| MP-01 | From a fresh browser, open the unified page. Watch download progress at startup. Choose New Game and confirm the native loading screen appears, with zero archive downloads after the main menu. Move, save, reload the save and return to the menu. Join Multiplayer. Return to Single Player and confirm its save, settings and campaign behavior. Apply 720p after 1080p in Video settings while keeping the same window size. Confirm the picture stays the same size and WebGPU reports no validation errors. Resize the browser and check that the view fills it without stretching. Repeat the clicks at 100% scaling and on Windows/Brave at scaled DPI. In Advanced Video, confirm fresh settings use 60 FPS with VSync on. Apply 30 FPS and reload to check that both settings are saved. | **Partial.** Hosted unified flow and local campaign regressions recorded. Chrome showed the native New Game loading screen from the installed pack, with zero archive downloads after startup. The current local candidate passed both named save and stock F5/F9 round trips. Six modeled layouts passed input and aspect checks. Chrome at 100% scaling applied 720p through the menu with the picture in place. Resizing to a wider viewport afterwards also passed with zero WebGPU validation errors. A fresh Chrome settings profile started at 60 FPS with VSync on and restored the 30 FPS cap after reload. Repeat the complete flow, including cold and warm loading and Windows menu clicks. [Unified build](acceptance/unified-game.json) · [Loading](acceptance/singleplayer-loading-progress.json) |
| MP-02 | Join as A, change the save by picking up a named item, copy the save key, close A and import the key in a separate profile. Confirm the same character, inventory and life. Repeat after restarting the server. | **Partial.** The rendered local check recovered the same life and exact seven-item inventory in a separate profile and after Rust restarted. Copy worked with Rust stopped. An unknown key preserved the second profile’s save. The public release also restored the same principal, life and six-item native inventory count in a second profile. Verify exact changed inventory on the hosted candidate after its next scheduled restart. [Save key recovery](acceptance/multiplayer-save-key.json) |
| MP-03 | A and B target the same authored loose item. Press Use together. Confirm that one player gets it and that it disappears for both. Equip, use or drop it as appropriate, let B re-loot it and reconnect/restart. Confirm one surviving instance, preserving its state through each transfer. | **Pass.** Two rendered engines submitted Use on the same initial revision in the same Rust tick. One got the stock 60-round box and it disappeared for both. The winner kept it through restart, dropped it through the original menu, and the other player re-looted the same ID and state. A second restart preserved the new owner and the authored placement stayed empty. [Same-tick pickup, drop and restart](acceptance/native-loot-race.json) |
| MP-04 | In the original inventory, drag a pistol and rifle between allowed slots, try an incompatible slot, equip/replace outfit and helmet, and move artefacts between exact belt cells and rucksack. Check tooltips, grouping, slot occupancy and individual item state after reconnect. Exercise single-item and stack actions with mixed state, including interrupted Drop All. | **Pass.** The original menu moved both guns into alternate slots, rejected a pistol in the helmet slot, swapped headgear and moved exact artefact belt cells. The sealed SEVA returned the helmet to the bag. Mixed-condition ammunition grouped as 38 and 9 rounds. A single drop left 25 and 9. The connection dropped after Rust committed the second Drop All command, before Chrome received the result. After Rust restarted, three original requests replayed, all five dropped boxes kept their IDs and round counts, and the worn box stayed carried. [Mixed inventory and interrupted drop](acceptance/native-mixed-inventory.json) [Inventory](acceptance/native-inventory-menu.json) · [Upgraded weapon](acceptance/native-upgraded-weapon-transfer.json) · [Batch drop](acceptance/native-inventory-batch.json) |
| MP-05 | A and B inspect the same authored stash. Empty a refill slot, stay within the exclusion distance past its cooldown, then move both players away. Confirm refill obeys the cap. Restart during cooldown and after refill. Collect a one-time loose placement and verify that its source stays empty. | **Pass.** Both engines saw the same stock stash item disappear after native pickup. The deadlines survived restart and expired while the stash stayed empty with either player nearby. Both walked out, the stash refilled to the cap of one, and a second restart preserved the SVD, the original ammo and the empty one-time placement. [Two-player stash refill](acceptance/native-stash-refill.json) |
| MP-06 | Draw and holster each firearm. Reload, cycle ammo and unload. Try incompatible ammo and an empty box. Use a tri-state shotgun, a mixed magazine and an upgraded weapon. Compare exact rounds, ammo types and weapon state after swap, drop and restart. | **Partial.** Verified native SVD reload and unload, AK-74 holster cancellation, first-person reload audio, interrupted SPAS-12 mixed-shell order, and TOZ-34 one-chamber top-up and ammo exchange. The upgraded Groza kept its exact state through the two-client drop, pickup, equip and server restart. Immediate reloads after switching between the Makarov and Abakan reached the correct weapon. The Makarov consumed its last compatible box, left incompatible rounds intact and recovered its exact magazine after restart. The original Y binding exchanged Makarov and Abakan magazines immediately after switching, returned the old rounds and kept both magazines and reserves after restart. Broader firearm coverage remains. [Magazine cycle](acceptance/native-magazine-cycle.json) · [Upgraded weapon](acceptance/native-upgraded-weapon-transfer.json) · [Switch and reload](acceptance/native-weapon-switch.json) · [Next Ammo](acceptance/native-next-ammo.json) |
| MP-07 | Use semi, burst and auto on supported weapons. Release or cancel the trigger by switching weapon, opening inventory or losing focus. Check that ammo stops spending. Jam a low-condition weapon, reconnect, clear it and confirm the misfire spent no round. Check sound, animation and HUD cues. Compare stationary and turning hip-fire, then repeat with the stock ironsight fully raised. At a measured distance, compare low and elevated aim and verify reduced damage at range. Compare a slug and buckshot against adjacent targets and through cover. Repeat against moving targets and check a grazing ricochet. | **Partial.** The Groza arc passed at 94 m, and three rendered clients verified TOZ-34 multi-target buckshot, armour wear and death. The stock glass trial blocked buckshot and attenuated the slug. A grazing TOZ-34 shot banked off a separate glass panel and killed the target in two rendered clients. The Makarov used stock turn dispersion and the Abakan fired nine rounds in a held automatic burst, with no further debits on release. Repeat trigger cancellation with two engines and verify jam cues, moving-target flight time and material impact presentation. [Firearm ballistics](acceptance/native-owned-ballistics.json) · [Buckshot](acceptance/native-owned-buckshot.json) · [Material cover](acceptance/native-owned-material-cover.json) · [Observer audio and visuals](acceptance/native-observer-gunshots.json) · [Fire modes](acceptance/zaton-fire-modes.json) · [Misfire](acceptance/zaton-weapon-misfire.json) · [Aim](acceptance/native-firearm-aim.json) · [Turn and held trigger](acceptance/native-firearm-turn.json) |
| MP-08 | Fit a compatible scope, suppressor and launcher using the native context menu or drag path. Reject incompatible or duplicate addons. Switch launcher mode, load and fire, then detach a loaded launcher in a separate trial. Confirm the two magazines stay independent and detaching returns the original addon and loaded grenade. | **Pass.** The stock LR300 context menu fitted and detached a SUSAT 1.6, suppressor and M203. The fitted reticle, bare Abakan, projectile flight and impact rendered in Chrome. Binary authority rejected the incompatible PSO and occupied scope slot. The launcher spent one grenade and later returned a separately loaded grenade and original M203 on detach, preserving all four rifle rounds. [Rendered attachments](acceptance/native-attachments.json) · [Persistence](acceptance/zaton-attachments.json) · [Blast](acceptance/zaton-launcher-blast.json) |
| MP-09 | Quick-throw and charge a hand grenade. Cancel a charge and verify it spends nothing. Compare F1/RGD-5 damage against cover and armour with harmless GD-05 smoke. Verify the equipped replacement, safe-zone refusal, flight, particle and sound cues from the thrower and a nearby observer. | **Pass.** Rendered Zaton clients used the original controls for pin pull, quick and charged throws, and cancellation without a debit. Both smoke flights drew and played positional sound with no damage. The same-type and different-type replacements and the last-grenade return to the Makarov worked. Stock cover protected both sheltered exoskeleton wearers. At the same distance, the RGD-5 left 78 health and the F1 left 10, with corresponding armour wear. The safe zone refused the F1. [Rendered grenades](acceptance/native-grenade-presentation.json) |
| MP-10 | Equip the starter knife and try slash and stab, with targets in range, beyond reach and behind cover. Compare bare and armoured targets. Try a protected target and check health, bleeding, wear and full-loss death on valid hits. Observe attack presentation from both players. | **Pass.** Two rendered engines verified the original slash, stab, recovery motions and positional sound. Both attacks missed at 4.63 m, were blocked by stock glass at 1.12 m and left a protected target unharmed across Skadovsk's boundary. The close slash killed the bare target and wounded the armoured target. The stab killed the armoured target and a restart preserved all seven carried items in the corpse. [Rendered knife](acceptance/native-knife-presentation.json) · [Authority](acceptance/zaton-starter-knife.json) |
| MP-11 | A stores an upgraded or loaded item in the Skadovsk locker, then equips other gear. B kills A outside protection. A reconnects dead. B searches the corpse, takes an individual item and then Take All. A respawns with the configured new kit and retrieves the exact stored item. Repeat with an unlooted corpse and a loose drop through expiry, including a server restart. | **Pass.** Two rendered clients verified the combined locker, death and recovery sequence, including drag, Ctrl+X and denied foreign access. A separate run verified an unlooted corpse and loose drop before and after a server restart, then through expiry with accelerated development timers. [Full-loss evidence](acceptance/native-locker-full-loss.json) · [Private locker](acceptance/native-private-storage.json) |
| MP-12 | Take a hit outside Skadovsk, cross into safety while combat-locked and verify that an outside opponent can still damage the locked player. Attempt to attack from inside. Wait for lock expiry and recheck protection. Disconnect while vulnerable. Test same-body rejoin, expiry and death while offline across a server restart. Repeat while protected. | **Pass.** Two rendered clients crossed the stock Skadovsk boundary with the original controls, verified damage and the fire block during combat lock, then tested protection, immediate protected logout, same-body vulnerable reconnect, expiry and death while offline after a Rust restart. The dead save reopened empty and Enter granted six items for the next life. The optimized browser now restores heading and crouch on protected and vulnerable reconnect, including after restart. [Logout](acceptance/zaton-vulnerable-logout.json) |
| MP-13 | Sprint at ordinary and overloaded weights. Pick up past the threshold, compare sprint and stamina, equip an exoskeleton or belt modifier, then wait for a temporary boost to expire. Treat bleeding, eat, drink and test the four quick-use bindings. Verify the right dose is consumed once and active effects resume after reconnect. | **Pass.** The rendered Zaton run verified stock movement keys, the original Use and four quick-use bindings, both weight thresholds, the overweight indicator, the exoskeleton and Goldfish bonuses, and boost recovery after Rust restarted. A separate rendered run held the inventory open until the full five-minute Hercules timer expired. [Combined survival loop](acceptance/native-survival-loop.json) · [Treatment](acceptance/native-survival-treatment.json) · [Weight](acceptance/zaton-carrying-weight.json) |
| MP-14 | Enter authored radiation, acid, heat and psy fields with and without matching protection. Check health, stamina, radiation, psy health and gear condition. Belt and unbelt artefacts, take the matching medicine, reconnect during protection, and die in one hazard while carrying gear. Confirm protection, wear and corpse transfer agree across the HUD and inventory. | **Pass.** Rendered Zaton checks walked into all four field types. Armour reduced acid and heat damage and wore down. Meat Chunk stopped acid damage while belted. All three matching medicines spent one dose and showed their original shield icons. Antidote survived a Rust restart, radioprotector blinked and cleared on expiry, and acid death transferred all eight items. Native field post-processing remains under G-07. [Rendered fields](acceptance/native-continuous-fields.json) · [Transport evidence](MECHANICS.md#continuous-acid-heat-and-psy-fields) |
| MP-15 | Quick-throw a bolt into a Zaton Electra from outside the trigger radius, then charge a second throw and compare the path. Walk into the same field after recharge. Verify bolt reuse, shock, discharge cue, armour wear and death transfer. Repeat near another actor and attempt a throw from safety. | **Pass.** Two rendered clients verified native bolt flight, different quick and charged speeds, the stock Electra flash and particles, positional audio consumed by both AudioWorklets, and contact damage, gear wear and seven-item corpse transfer. The same world verified stock Skadovsk throw refusal and retained the bolt, selected slot, death and corpse items after Rust restarted. First-person throw animation remains under G-05. [Rendered Electra](acceptance/native-electra.json) · [Three-peer stock test](acceptance/zaton-bolts-electra.json) |
| MP-16 | Equip each detector tier and use the original binding at an authored site. Compare cues, rank filters and reveal radii. Check that a stowed or unequipped detector cannot reveal items. Test the broken threshold with a detector configured to use condition. After revealing an item, stow the detector and wait five seconds. Race for a revealed item from two engines, reconnect, restart and belt the winner's artefact. | **Pass.** Chrome verified the four original handheld models and reveal boundaries, Echo and Bear AudioWorklet output, Echo rank filtering, the configured 1% cutoff and player-scoped expiry. One player won a Crystal pickup race and recovered and belted it after restart. A separate Night Star run verified original inventory double-click to the first belt cell after restart. Tests seeded detector gear. Further detector behavior and progression are tracked under G-02. [Rendered detectors](acceptance/native-detectors.json) · [Zaton transport](acceptance/zaton-detector-artefacts.json) |
| MP-17 | Observe A as nearby B and distant C. A changes outfit, equips/stows a helmet, draws and holsters a firearm, then crosses visibility range and returns. Check placement, animation and update timing. Verify the public view exposes only appearance. | **Pass.** Three rendered browsers verified the outfit, helmet, rifle draw and holster, helmet stow, and visibility entry, exit and return. The nearby observer saw the stock movement and firing pose with the muzzle ahead of the actor. A separate two-browser run verified each LR300 attachment fit and removal, holster, redraw and observer reconnect. Only model and appearance metadata reached observers. [Rendered equipment evidence](acceptance/native-equipment-visibility.json) · [Rendered attachments](acceptance/native-remote-addons.json) |
| MP-18 | Use approved campaign crossings, the underpass ladder and the Lab X8 lift in both directions. Test range, generator power and access card. Interrupt loading after departure, reconnect and restart. Verify one body on the correct map and unchanged life, items, condition and combat lock. | **Partial.** The public server runs all five maps and the approved routes. Local and isolated Fly drills exercised selected crossings. Verify normal rendered approaches, underground exits and interrupted browser loading on the hosted build. [Travel](MECHANICS.md#campaign-maps-and-travel) |
| MP-19 | Start the native A-Life host in Zaton. Verify live and offline squads. Put two players in separated areas and confirm nearby squads activate independently, then converge on one encounter and see the same pursuit, attacks, health and death. Verify a protected player takes no damage. For an armed NPC, contest its stock corpse contents and restart. Leave and return to verify native offline progression. | **Partial.** Stock dogs damaged players and safe-zone protection held. Controlled native hits verified player death and carried-item transfer. Two Chrome clients received the same moving NPC and native rifle, knife and grenade kills. A rendered stock Gauss shot at 150 penetration killed a native stalker, with a matching death snapshot and one durable round debit. One rendered TOZ-34 shell then verified accumulated native pellet damage, with both browsers observing 6 health after the first hit acknowledged 91. Rendered input verified the original knife stab and RGD-5 prime and release bindings. Two Chrome clients also contested a stock stalker's rifle and verified the winner's item and corpse contents after a Rust restart. Two stock sites 661 m apart activated independently. The same snork squad moved offline and reactivated when the player returned. The original F and X controls opened and emptied a stock NPC corpse in a separate two-engine run. A rendered reconnect after Rust restarted preserved all 11 items. Two original Take All menus also contested all 11 items within the same measured millisecond. The six-item and five-item inventories survived a rendered reconnect after Rust restarted. Convergence through normal movement, rendered pursuit and attack effects, and the single-item UI race remain open. ARM64 Linux and disposable Fly x86-64 both restored a checkpoint in place and replayed the same corpse. Rust rejected a matching older save and fence after restarting, then admitted the current pair and deduplicated the loot replay. Stock pursuit and damage passed in hidden macOS and displayless Ubuntu ARM64. [Native bootstrap](acceptance/native-alife-bootstrap.json) · [Activation](acceptance/native-alife-interests.json) · [Split sites and offline progression](acceptance/native-alife-split-squads.json) · [Target encounter](acceptance/native-alife-targets.json) · [Native damage](acceptance/native-alife-damage.json) · [Native replicas](acceptance/native-alife-replicas.json) · [Player attacks](acceptance/native-alife-player-attacks.json) · [Knife and grenade](acceptance/native-alife-close-combat.json) · [Armed NPC loot](acceptance/native-alife-corpse.json) · [Headless host](acceptance/native-alife-headless.json) · [Native checkpoints](acceptance/native-alife-checkpoint.json) · [World admission](acceptance/native-alife-world-admission.json) · [200 native proxies](acceptance/native-alife-proxy-cadence.json) · [200 local WebRTC peers](acceptance/native-alife-webrtc-population.json) |

### Multiplayer movement and NPC presentation regressions

- Walk, run and sprint past a second player in Zaton. The local camera should
  move smoothly, and the observer should see distinct stock walk, run and
  sprint clips. Repeat with delay and packet loss, including a brief gap in
  native movement acknowledgements. Check that local movement continues and
  settles back onto the host position when updates resume.
- Watch a walking stalker near the edge of visibility, then damage it without
  killing it. Check the hit reaction, subsequent native AI behavior and smooth
  movement between host updates on both clients.
- With native movement enabled, fire a rifle round and a buckshot shell at
  an exposed NPC and then at the edge of its silhouette or through closed
  cover. Confirm one ammo debit and one reply per trigger pull. Only stock
  skeleton contacts with the authorized NPC should damage it.
- Watch an armed stalker draw, aim, fire, reload and holster. Compare the held
  weapon, firing motion, muzzle effects and sounds with single player. Check a
  moving shooter and a shooter with a suppressor or launcher attachment.
- Kill an armed stalker and wait for its lootable body. Check that it never
  stands in its bind pose and that only one body is visible after discovery.
  Repeat with two NPCs close together and verify both loot containers.
- Repeat the downhill report, stairs, crouch transitions and a ladder in
  single player and the X-Ray multiplayer preview. Both multiplayer sides
  use the stock controller in this preview. Movement parity is open for manual
  verification, along with collisions between players and moving objects.
- Drop from a height and collide with a moving prop outside a safe zone. Check
  that native collision damage is applied once and persists across reconnect.
  Compare a small drop and a larger drop. Repeat within protection and after a
  respawn to check that an impact cannot cross lives.
- Equip a worn or upgraded outfit, a helmet and two belt artefacts on the
  native-host preview. Move an artefact to a different cell, then swap the
  outfit for one with fewer cells. Check that displaced artefacts return to
  the rucksack with their original condition. Reconnect and travel to verify
  placement, condition and upgrades. After death, check that the gear
  appears once in the player's durable loot. Take a native NPC melee hit
  with the outfit equipped and verify mitigation and saved wear. Repeat
  after an equipment change and within a protected area.
- Open the same map from two browsers at different times. Compare the PDA
  clock, lighting, and weather. Travel to another active map and compare its
  clock. Join during a weather effect and check the remaining duration.
- Approach a running positional sound source, move past it, and leave its
  audible range. Check that it keeps playing as the source moves and stops
  after leaving range or when its source stops.
- Join with a fresh save key and check slots 2 and 3 for a PM and an AK-74.
  Draw and holster each firearm, fire or reload, and change the fire mode.
  For an AK-74 with a launcher, switch between magazines and check that
  selection, ammunition and jam state survive a reconnect.
  Check the rucksack for 50 rounds of 9×18 and 60 rounds of 5.45×39. Reload
  both weapons. Verify a reconnect preserves the current inventory and a new
  life after death grants the kit once.
- With the native map host enabled, compare the magazine limit shown in
  multiplayer with the same weapon and upgrades in single player. Try an
  AK-74 top-up, a SPAS-12 reload interrupted after one shell and a Groza
  grenade reload. Check the rendered reload cues, reserve counts and the
  rifle magazine after switching back from the launcher.
- In a native-host match, fire buckshot and slugs from the same SPAS-12
  magazine. Compare damage and wear with the same weapon in single player
  under controlled conditions. On an LR300, compare shots with and without
  the suppressor fitted, including the nearby observer's sound.

## Omissions and remaining work

Keep open entries until they are implemented and verified, explicitly removed
from scope, or superseded by a linked decision. Use **Unimplemented** for absent
gameplay, **Limited** for an approximation or incomplete implementation,
**Deferred** for postponed work, **Out of scope** for excluded features, and
**Decision** for an unresolved rule. Record validation-only gaps on the matching
test case above.

| ID | Status | Work or scope boundary |
|---|---|---|
| G-01 | Limited | Native A-Life boot, activation, target selection, NPC damage, safe-zone protection, shared rifle, knife and grenade kills, armed-NPC loot contention with Rust restart and native outbox recovery are verified locally. Hidden macOS and displayless Ubuntu ARM64 also passed stock Zaton startup and damage. Temporary Fly x86-64 cold startup, fenced in-place restart and corpse replay passed with the asynchronous host. Verify rendered pursuit and attack effects, single-item UI contention, and end-to-end AI budgets at target population. A local five-map run verified player-interest handoff and isolated host recovery. All five public hosts saved checkpoints on the 12 GiB Machine. Campaign capacity at the target population and NPC migration between maps remain open. Local tests passed with 200 synthetic native proxies and with 200 real WebRTC peers at one crowded site. Four local split-site checkpoints stayed under 100 ms with new JIT compilation paused during object-save callbacks. The same split on a disposable Fly x86-64 Machine reached 131.48 ms. The x86-64 capture budget remains open. MP-19. |
| G-02 | Limited / Decision | Finish moving artefacts and emission-driven layer changes. Define Zaton detector acquisition and normal progression for all tiers. Verify detector discovery at the target population. Svarog's layer 1 markers loaded for all five maps. Rendered Zaton verified the markers and fast stow and redraw during firearm aim, timed reload and climbing. Aim lets the previous reveal expire. MP-16. [Svarog evidence](acceptance/native-svarog-anomalies.json) · [Interlocks](acceptance/native-detector-interlocks.json) · [Aim](acceptance/native-firearm-aim.json) |
| G-03 | Limited / Decision | Shared loot imports reviewed placements. Classify three script-gated stashes, seven with mismatched counts, remaining story and quest loot, 113 Jupiter Underground candidates and four excluded explosive props. Decide the Lab X8 access-card source and exit policy. MP-05, MP-18. |
| G-04 | Limited | The server-selected first-person HUD plays stock draw, idle and confirmed firearm motions, shot sounds, muzzle flashes and smoke. Nearby observers get stock positional sounds, torso firing motions and world-model muzzle effects. The optional timing export enables authoritative reload phases and first-person sounds. Native upgrade presentation is verified for capacity and calibre changes. Rust steps the rewound flight using shared X-Ray flight and penetration rules. With native movement enabled, rifle shots resolve against rewound animated player bones. Check silhouettes in rendered moving engagements. Finish native weapon state and projectile execution, crosshair interpolation, adjustable magnification, special scope effects, dynamic-body continuation, ricochet self-hits, material impact cues, lighting, casing and jam effects, and remaining upgrade variants. Verify rendered engagements beyond the current 100 m replication radius. MP-04, MP-06 through MP-08. [Cutover plan](PLAN.md#player-combat-cutover) · [Aim evidence](acceptance/native-firearm-aim.json) · [Turn evidence](acceptance/native-firearm-turn.json) |
| G-05 | Limited | Grenade and bolt flight use simplified bounce. Stock grenade spin, fragments, blast impulse, explosion lighting and decals remain open. In-flight grenades are discarded on server process exit. Knife hit impulses on players remain open. MP-09, MP-10, MP-15. [Rendered grenade](acceptance/native-grenade-presentation.json) · [Rendered knife](acceptance/native-knife-presentation.json) |
| G-06 | Limited | Remaining campaign route approval and rendered hosted travel tests. The public campaign runs all five maps. The isolated Linux Fly test verified the Zaton-to-Jupiter crossing. Normal acquisition of the Lab X8 access card and stock quest and guide travel gates still need review. Dynamic doors, props, platforms, player collision and water remain outside the static motor. Two nearly co-located players can intersect the first-person view, including a retained logout body. MP-18. [Overlap evidence](acceptance/native-detectors.json) |
| G-07 | Limited | Complete reactive anomaly families beyond Electra, idle anomaly cues, blowout lighting for other anomaly families, emission-driven layer changes and native psy field post-processing. Four Pripyat Electras exclusive to the alternate layer remain dormant in the current export. MP-14, MP-15. |
| G-08 | Limited | Bullet, knife and native NPC hits record wound location when known. Healing and bleeding use the X-Ray wound rules. Check multiple wound sites, bandages and reconnect. Native wound randomization, script-only consumables and slung weapons remain open. Recent live condition can roll back to the last checkpoint after an abrupt crash. MP-13, MP-17. |
| G-09 | Deferred / Out of scope | Trading, vendors and currency follow the core loot loop. The agreed CoP inventory model excludes pocket capacity, backpack progression and detachable magazines. |
| G-10 | Decision | Tune starter gear, spawn locations, loot quantities and timers, corpse and drop expiry, locker capacity, survival rates, safe-zone boundaries and logout/combat-lock windows after playtesting. [Development defaults](MECHANICS.md#configurable-development-defaults) |

## Run log and upkeep

The optimized native and Rust Zaton fixture used two headless WebRTC clients.
All five AK-74 rounds hit exported bones, including two while the target
moved. SQLite recorded one debit per shot and committed the victim's death.
Rendered moving engagements, projectile timing and capacity remain open.
An isolated headless Chrome session started the optimized single-player build
in Zaton and passed F5 save and F9 load with zero WebGPU validation errors.
The wound follow-up used the same two-client Zaton fixture. SQLite retained
separate bullet wounds on the clavicle and spine after five confirmed hits
and five ammunition debits. The Rust suite covered treatment applied during
live healing and loading an older save with only a bleeding total.

Update this file in the same change as a new or modified mechanic. Add or
revise its case and scope entry, and link any new evidence. For a run, add a
row with `date | client and server revisions | environment | case and result |
evidence or reason`. Preserve earlier failures, skipped cases and their reasons
when a rerun passes. When a gap closes, record the implementing change and the
evidence, or link the decision that removed it from scope.

| Date | Build and environment | Cases and result | Evidence or reason |
|---|---|---|---|
| 2026-11-08 | Initial checklist based on the repository checkpoint | Historical coverage recorded above | Existing evidence carried forward. Current candidate playthrough awaits a recorded run. |
| 2026-11-08 | Optimized local schema v20 server and unified build. Stock Zaton, five WebRTC peers, seeded detectors and nearby saves. | MP-16 transport and persistence checks passed. Rendered playthrough skipped. | Local browser automation is disabled. [Zaton detector evidence](acceptance/zaton-detector-artefacts.json) |
| 2026-11-08 | Optimized unified and standalone builds. Six modeled layouts at DPR 1–2. | MP-01 aspect and input math passed. Live clicks and Windows/Brave rendering skipped. | Local browser automation is disabled. [Browser display and input](../misc/web/README.md) |
| 2026-11-08 | Optimized native Apple ARM64 build and disposable Zaton campaign. | MP-19 native bootstrap passed. Headless launch and localized autosave failed. Two-player playthrough blocked. | Cocoa ran the stock scripts. Offscreen OpenGL failed to initialize. This run used the original campaign actor as the sole activation point. [Native bootstrap evidence](acceptance/native-alife-bootstrap.json) |
| 2026-11-08 | Optimized Rust server and native Apple ARM64 host, two WebRTC peers on stock Zaton. | The host received both poses. Three creatures near one peer moved over one metre, then went offline after the feed expired. | The separate socket drill verified split coverage. The second site had no living creature in range during the capture. [Activation evidence](acceptance/native-alife-interests.json) |
| 2026-11-08 | Native actor targets on an optimized local Zaton host, two WebRTC peers. | Both native targets tracked grounded Rust poses and expired when the feed stopped. Mutants selected both targets and landed one native hit. | The following runs verify damage return and NPC state replication. [Target lifecycle evidence](acceptance/native-alife-targets.json) |
| 2026-11-08 | Optimized native CoP and Rust with two WebRTC peers on stock Zaton. | Stock dog damage replicated to both peers. Six protected hits caused no damage. Controlled native events verified death and all six carried items in the corpse. | Player attacks on native NPCs and armed-NPC loot remain open. [Native damage evidence](acceptance/native-alife-damage.json) |
| 2026-11-08 | Optimized native CoP and Rust with two Chrome clients in Zaton. | Both clients received a moving stock dog, loaded the model and motion, and removed the NPCs after the host stopped. Single-player Zaton also loaded from the unified build. | The background screenshot was black. Full foreground pursuit and attack effects remain open. [Native replica evidence](acceptance/native-alife-replicas.json) |
| 2026-11-08 | Optimized native CoP and Rust with two Chrome clients in Zaton. Two attempts with unprotected observers. | MP-19 rifle damage and ammunition debit passed. Shared death observation failed. | The stock AI killed the observer during setup in both runs. [Player attack evidence](acceptance/native-alife-player-attacks.json) |
| 2026-11-08 | Same optimized builds, disposable Zaton safe zone covering the observer while the shooter stayed outside. | MP-19 both Chrome clients received the same stock dog death in the same snapshot tick. SQLite retained the ten remaining AK-74 rounds after shutdown. | The harness used browser WebRTC actions and authoritative aim samples. The rendered first-person attack, knife and grenade cases remain open. [Player attack evidence](acceptance/native-alife-player-attacks.json) |
| 2026-11-08 | Optimized native CoP and Rust schema 21, stock Zaton and two Chrome WebGPU clients. A disposable native script spawned and killed a generic stalker. | MP-19 both browsers saw the stock corpse and raced for the same LR-300. One got it. After restarting Rust, the winner kept the same rifle and the corpse still held the other ten items. | The first run stopped at the native startup prompt. A subsequent run exposed a buried loot anchor, fixed by projecting it to nearby walkable floor. Browser actions verified the transport path. Manual interaction and native restart remain open. [Armed NPC loot evidence](acceptance/native-alife-corpse.json) |
| 2026-11-08 | Optimized macOS ARM64 native CoP and Rust, disposable stock Zaton. | MP-19 pending native loot survived killing the host before Rust received the event. A replacement reclaimed the stale socket and imported eleven items. A simulated lost acknowledgement replay preserved the exact items. | The first immediate restart still encountered the old process lock. The passing restart verified the old process had exited. Native world save rollback and the production Linux restart remain open. [Native loot recovery evidence](acceptance/native-alife-outbox.json) |
| 2026-11-08 | Optimized macOS ARM64 native CoP, disposable stock Zaton and a private socket harness. | MP-19 hidden host startup, two player proxies, live lighting, mutant movement and autonomous damage passed. | Cocoa was available. The host skipped presentation and kept the graphics context needed for stock model data. [Headless host evidence](acceptance/native-alife-headless.json) |
| 2026-11-08 | ARM64 Ubuntu 24.04 container with SDL 2.30 and Mesa llvmpipe. | Displayless SDL graphics initialization passed. Full MP-19 Linux startup pending. | The first native build exceeded the VM memory limit. Retrying with one compiler process. [Headless host evidence](acceptance/native-alife-headless.json) |
| 2026-11-08 | Optimized Ubuntu 24.04 ARM64 native host, SDL offscreen, Mesa and OpenAL null output. | MP-19 stock Zaton started without a desktop and delivered an autonomous native dog hit while tracking two player proxies. | The first native run failed LuaJIT initialization. The PIE allocator probe confirmed the engine allocation exceeded LuaJIT’s address range. The passing run used the built-in allocator. [Headless host evidence](acceptance/native-alife-headless.json) |
| 2026-11-08 | Optimized x86-64 native host on a disposable Frankfurt Fly Machine, 11 hash-verified public CoP archives. | MP-19 displayless cold startup, two player proxies and autonomous damage passed. A verified checkpoint copy loaded and republished moving mutants. | The first in-place restart failed the checkpoint fence. No autonomous hit was observed in the restart test. The artifact predates the asynchronous persistence changes. [Headless host evidence](acceptance/native-alife-headless.json) |
| 2026-11-08 | Optimized macOS and displayless Ubuntu ARM64 native hosts, stock Zaton. Linux used a 250 ms delay per worker file sync. | MP-19 native capture stayed below 100 ms in the measured runs. NPC updates continued during slow persistence. Linux resumed in place and replayed the same 12-item corpse. An older standalone save was rejected. | The earlier macOS sync build also restored the world and imported one 12-item corpse into Rust after lock release. The latest unified browser build loaded single-player Zaton with zero WebGPU validation errors. Target population and the production x86-64 restart remain open. [Checkpoint evidence](acceptance/native-alife-checkpoint.json) |
| 2026-11-08 | Optimized macOS ARM64 native CoP and Rust schema 22, stock Zaton, one pose supplied by a private relay. | MP-19 restarted Rust rejected an older save and its matching fence, preserving a newer outbox record. The current checkpoint rejoined and replayed the same death with one 11-item corpse in SQLite. | The first relay failed sender matching on macOS. The passing run matched the native socket address length. It used stock NPC logic and a controlled spawn and hit fixture. The latest unified browser build loaded single-player Zaton with zero WebGPU validation errors. [World admission evidence](acceptance/native-alife-world-admission.json) |
| 2026-11-08 | Optimized native CoP and Rust schema 22, stock Zaton and a private relay supplying 200 grounded synthetic poses. | MP-19 all 200 proxies stayed active during the sample and were removed after the feed expired. Frame-loop polling increased NPC updates from 108 to 300 per 30 seconds. The p95 gap dropped from 313 to 127 ms and capture peaked at 73 ms. | The first harness aborted on datagram backpressure. Later runs counted drops and continued with full snapshots. The fixture covered one crowded site and left real-client capacity open. [Native proxy cadence evidence](acceptance/native-alife-proxy-cadence.json) |
| 2026-11-08 | Optimized native frame-loop bridge, Rust schema 22 and two Chrome WebRTC clients on stock Zaton. | MP-19 Rust admitted checkpoint generation 1. Both clients received the same native dog death at tick 676. Both players stayed at full health, and SQLite retained the four remaining AK-74 rounds. | The harness used the browser WebRTC API and authoritative aim samples. Both browsers reported zero WebGPU validation errors. Manual aim, knife and grenade remain open. [Player attack evidence](acceptance/native-alife-player-attacks.json) |
| 2026-11-08 | Optimized Rust, native CoP and two Chrome WebRTC clients, stock Zaton with disposable stalker placements. | MP-19 both clients received the same slash damage and RGD-5 damage. The optimized collision recheck replicated a stab kill and an RGD-5 kill. The protected observer stayed at 100 health. SQLite retained the replacement grenade and imported two native corpses. | The first setup duplicated the starter knife and was corrected to use the original grant. The browser harness sent stock weapon commands and sampled authoritative aim. First-person input and effects remain open. [Native close combat](acceptance/native-alife-close-combat.json) |
| 2026-11-08 | Optimized Rust and two Chrome WebGPU clients on stock Zaton, authored spawn 1183 and grounded fixture locations. | MP-03 both engines used the original binding on revision 0. One got the item. After a Rust restart the winner dropped it with the original context menu, and the other player picked up the same 60 rounds at revision 3. A second Rust restart preserved only the new owner. | The earlier rooftop fixture produced no pickup intent. Initial browser submissions were 1.8 seconds apart. Two automated Drop clicks missed the row before correcting the cursor hotspot. [Two-engine loot evidence](acceptance/authored-loot-native-contest.json) |
| 2026-11-08 | Optimized unified build and local Rust on stock Zaton. Two independent Chrome profiles with an isolated copy of the authored-loot database. | MP-02 normal browser clicks copied the enrolled key with Rust stopped, rejected an unknown key and restored the same character and seven items after importing the valid key. Restarting Rust preserved the imported character and exact item state. | The initial panel clipped its bottom and pointer lock redirected clicks to the canvas. The candidate makes the panel scrollable and releases pointer lock on open. Clicking the canvas after closing the panel recaptures the pointer. [Save key recovery](acceptance/multiplayer-save-key.json) |
| 2026-11-08 | Public Zaton release, two disposable Chrome profiles over Fly WebRTC with a verified warm pack. | MP-02 Copy save key and Open save restored the same principal and life 0. The original engine reported six items in both profiles and zero WebGPU validation errors. | The initial direct route omitted the deployed menu’s map parameter. An extra inventory probe stalled, so the passing smoke used the native inventory report. The public service stayed online. [Save key recovery](acceptance/multiplayer-save-key.json) |
| 2026-11-09 | Optimized native CoP and Rust with two Chrome WebRTC engines on stock Zaton, two grounded sites 661 m apart. | MP-19 A activated three squads while B’s site stayed offline. With both players present, each saw its own NPC roster. When A left, its squads switched offline. A stock snork squad travelled 30.48 m while offline and returned with the same native identity. | The disposable rules disabled the 60-second vulnerable logout body. Both browsers reported zero WebGPU validation errors. Checkpoint wall time reached 146.25 ms, including 84.32 ms of preparation. [Split-site evidence](acceptance/native-alife-split-squads.json) |
| 2026-11-09 | Same split-site setup with an optimized object-registry checkpoint serializer. | MP-19 separate activation, offline movement and reactivation passed again. Checkpoint wall time peaked at 116.41 ms. Serialization peaked at 38.88 ms. | The slow capture spent 82.53 ms preparing client state. Test sequences use independently spawned stock NPCs. [Split-site evidence](acceptance/native-alife-split-squads.json) |
| 2026-11-09 | Optimized Rust, native CoP and 200 real Chrome WebRTC data channels on loopback, moving near one stock Zaton site. | MP-19 all 200 proxies activated. Over 40.12 seconds each peer received three native mutants, zero clients went stale and Rust averaged 29.96 ticks per second. The checkpoint peaked at 81.26 ms. | One Chrome generated scripted inputs and durable record writes without rendering the game. Sustained WAN, spread and mixed-combat load remain open. [Native WebRTC population evidence](acceptance/native-alife-webrtc-population.json) |
| 2026-11-09 | Optimized native CoP with the shared serialization packet, stock Zaton and a private pose relay. | MP-19 after Rust restarted, the older world pair was refused and the newer checkpoint replayed one corpse with all 12 original item IDs and states. | The fixture placed and killed one stock stalker to generate the same outbox record. [World admission evidence](acceptance/native-alife-world-admission.json) |
| 2026-11-09 | Rebuilt optimized unified WASM after the checkpoint serializer change. | MP-01 single-player Zaton started, wrote a 624,401-byte named save, reloaded it and resumed rendering with zero WebGPU validation errors. | The harness used the original in-game console for save and load. The quick-save binding produced no quicksave in this profile. The menu-driven flow remains open. [Save compatibility evidence](acceptance/native-alife-world-admission.json) |
| 2026-11-09 | Same stock split-site world restored in place, two rendered Chrome WebRTC clients stayed active for a further minute. | MP-19 both sites remained active. The checkpoint log recorded 129.55 and 141.15 ms of capture time. The slower capture used 140.98 ms of thread CPU and 103.20 ms of client-save preparation. | The split-site capture budget remains open. The 200-peer crowded-site result covers a different NPC workload. [Split-site evidence](acceptance/native-alife-split-squads.json) |
| 2026-11-09 | Optimized macOS native host restored the stock split-site world with checkpoint JIT compilation scoped off and two rendered Chrome WebRTC clients. | MP-19 both sites stayed active for about two minutes. Four captures took 54.00, 71.83, 92.64 and 66.75 ms. Both clients remained at full health. | The run used the same sites at a later point in the simulated world. Production Linux x86-64 timing remains open. [Split-site evidence](acceptance/native-alife-split-squads.json) |
| 2026-11-09 | Optimized unified Chrome WASM64, local Rust and stock Zaton A-Life. Separate rendered trials used original number keys and right-click with scripted relative camera motion. | MP-09, MP-10, MP-19 the native stab killed the same stalker on both clients. The RGD-5 launched and both clients received the same blast and a drop from 100 to 30 NPC health. The protected observer stayed at 100. | The first trials exposed WASM64 string-pointer conversion errors. The optimized ABI test now covers both knife modes and all grenade phases. The combined attempt lost focus during grenade aiming. First-person animations, flight presentation and positional audio remain open. [Rendered combat evidence](acceptance/native-alife-close-combat.json) |
| 2026-11-09 | Optimized displayless Ubuntu x86-64 native host and release Rust on a disposable Frankfurt Fly Machine. | MP-19 Rust refused the older native pair, then admitted the current save after an in-place restart. Replaying the intentionally unacknowledged transfer preserved one corpse and all 11 item IDs and states. | The first attempt did not wait for the explicit rejection log. The passing trial used one injected grounded pose and a controlled stock NPC death. [World admission evidence](acceptance/native-alife-world-admission.json) |
| 2026-11-09 | Optimized displayless Ubuntu x86-64 on a disposable Frankfurt Fly Machine, stock Zaton, two injected grounded poses 661 m apart. | MP-19 stock squads stayed active near both poses. Four captures took 90.57, 131.48, 82.54 and 120.77 ms. | Two captures exceeded 100 ms. The worst spent 105.85 ms in serialization. This test used a private pose relay. [Split-site evidence](acceptance/native-alife-split-squads.json) |
| 2026-11-09 | Final optimized unified browser stage with the native knife and grenade input fix. Single-player Zaton used the warm archive pack. | MP-01 a 623,198-byte named save and a separate 624,518-byte stock F5 quicksave both reloaded. F9 resumed rendering with zero WebGPU validation errors. | The first F5 coincided with the localized startup save. The passing shortcut check waited for gameplay and reloaded the standard quicksave with the console closed. The combined menu and cold-install route remains open. [Unified build evidence](acceptance/unified-game.json) |
| 2026-11-09 | Optimized unified Chrome WebGPU, local Rust and native A-Life on stock Zaton. | MP-19 the original Use and Take All bindings transferred all 11 items from a gameplay-killed stalker. The other player received none. A rendered reconnect after Rust restarted and a SQLite read both confirmed the same owner and item state. | The test used scripted aiming and a protected looter. The separate two-menu race is recorded below. [Armed NPC loot evidence](acceptance/native-alife-corpse.json) |
| 2026-11-09 | Same optimized browser build in stock Zaton with a seeded AK-74, knife and RGD-5, followed by a warm-pack single-player run. | MP-06 the stock first-person models were visible and the rifle stayed visible after a server debit from 12 to 11 rounds. Third person and holstering hid the model. MP-01 F5/F9 resumed Zaton with zero WebGPU validation errors. | Headless focus changes logged pointer-lock warnings. Fire, reload and throw animations and the remaining firearm variants still need rendered checks. [Weapon HUD evidence](acceptance/native-magazine-cycle.json) |
| 2026-11-09 | Two optimized Chrome processes with the first-person HUD, local Rust and native A-Life in stock Zaton. | MP-19 both original corpse menus submitted Take All for the same 11 items in the same measured millisecond. Rust assigned six to A and five to B. Both menus reconciled to empty. A rendered reconnect and SQLite verification after restarting Rust confirmed the same owners, revisions and state. | Timing was measured at browser intent submission. The first harness finished recording before teardown was forced for the separate restart phase. Single-item UI contention and the emptied body appearance remain open. [Armed NPC loot evidence](acceptance/native-alife-corpse.json) |
| 2026-11-09 | Optimized unified Chrome WASM64 and release Rust, stock Zaton with seeded firearms. | MP-07 the original mouse binding played three stock AK-74 firing motions, the PM's last-round motion and the Groza's launcher motion. The empty PM trigger was rejected without a firing cue. The same staged build passed MP-01 F5/F9. | Weapon animation calls and authoritative ammo were checked in gameplay. Headless focus changes logged pointer-lock warnings. Shot sound, muzzle effects, reload timing and the remaining firearm classes need checks. [Native firearm cues](acceptance/native-magazine-cycle.json) |
| 2026-11-09 | Optimized unified Chrome WASM64 and release Rust, seeded Zaton magazines. | MP-07 and MP-08 verified separate AudioWorklet voices for a three-shot AK-74 burst, a suppressed PB shot and a Groza launcher shot. A separate AK-74 burst showed nine flashes and drew stock flame, sparks and smoke with zero WebGPU validation errors. The same staged build passed MP-01 F5/F9. | The first renderer probe found the transformed effects were culled against the map origin. The fixed distance test was verified with a temporary trace and a clean release capture. Observer audio, muzzle lighting, casing effects, jam feedback and reload timing remain open. [Native firearm cues](acceptance/native-magazine-cycle.json) |
| 2026-11-09 | CoP 1.6.02 archive export and optimized unified Chrome WASM64 diagnostic build on Zaton. | The Rust checker validated timing metadata for 53 catalog weapons. All 70 timings across 33 weapon HUDs matched the engine's native calculation exactly. Two archive exports were byte-identical. | The browser probe measured durations. MP-06 still needs the live test that commits ammo after the animation and verifies interruption during a shell reload. [Reload timing evidence](acceptance/native-magazine-cycle.json) |
| 2026-11-09 | Optimized unified Chrome WASM64 and release Rust with `ZONE_RELOAD_TIMINGS`, seeded Zaton magazines. | MP-06 through MP-08 verified the AK-74 timed commit and holster cancellation, SPAS-12 insertion and interruption, Groza launcher magazine independence, and timed jam clearing. A server restart and replay returned the original shotgun receipt with exactly four shells. MP-01 F5/F9 passed on the same browser build. | Phase intervals were measured at browser receipt. Repeat with mixed ammo, break-actions and latency, and verify reload sounds. [Live reload evidence](acceptance/native-magazine-cycle.json) |
| 2026-11-09 | Optimized unified Chrome WASM64 and release Rust, two three-client Zaton runs. | MP-07 stock AK-74 burst, suppressed PB and Groza launcher sounds reached the near observer as positional AudioWorklet voices. The far observer and shooter received no positional shot cue. The empty trigger produced no cue. MP-01 F5/F9 passed on the same build. | This was a local loopback test. Observer muzzle effects and animations remain open. [Observer audio evidence](acceptance/native-observer-gunshots.json) |
| 2026-11-09 | Optimized unified Chrome WASM64 and release Rust, three clients in stock Zaton with a separate world-sprite draw probe. | MP-07 the observer played the standing AK-74 and PB motions and the crouched Groza launcher motion with the stalker outfit. Stock world-space muzzle sprites reached the renderer. MP-01 F5/F9 passed on the clean build. | The tests covered three stock weapons on loopback. Verify moving and aimed firing under network impairment, and complete lighting, casings and jam effects. [Observer presentation evidence](acceptance/native-observer-gunshots.json) |
| 2026-11-09 | Optimized unified Chrome WASM64 and release Rust with catalog-matched reload timings. | MP-06 through MP-08 verified stock reload PCM, holster cancellation, jam-clear fallback, a 1.2-second launcher sound delay, mixed SPAS-12 shell order, and the TOZ-34 ammo switch after restart. A forced same-frame shot and reload played both sounds and kept the reload motion. MP-01 F5/F9 passed on the final build. | Upgraded weapon and drop/re-loot tests remain open. Timed phases and their sound cues require the matching timing export on the deployed server. [Reload audio and shell evidence](acceptance/native-magazine-cycle.json#L718) |
| 2026-11-09 | Optimized unified Chrome WASM64 and release Rust, two rendered stock Zaton clients and a server restart. | MP-04 and MP-06 the original tooltip showed the upgraded 30-round Groza capacity. R loaded 11 rounds, G dropped it, F picked it up, and the original inventory equipped it on the second character. Both clients preserved exact mixed cartridge order. SQLite kept the same ID, condition, upgrade, loaded grenade and sole owner after restart. MP-01 F5/F9 passed. | Tested a seeded stock magazine upgrade and a separate 5.56 mm AK-74 conversion. Broader upgrade variants and firearm coverage remain. [Upgraded weapon transfer evidence](acceptance/native-upgraded-weapon-transfer.json) |
| 2026-11-09 | Optimized unified Chrome WASM64 and release Rust, two rendered clients on stock Zaton. | MP-11 stored five items and denied access by the other player. The kill moved all six carried items. The dead character rejoined from a SQLite backup after Rust restarted. The looter double-clicked the PM and took the other five items with Take All. Enter granted six new starter items, and Take All recovered the original Groza and four other locker items. MP-01 F5/F9 passed on the same build. | The test seeded equipment and scripted directional movement and camera motion. A third headless tab stalled before rendering and a fresh Chrome process loaded the same dead save. The separate Rust expiry regression reopened the database before advancing its clock. [Full-loss evidence](acceptance/native-locker-full-loss.json) |
| 2026-11-09 | Same build and stock Zaton, separate two-client run with 75-second corpse and 90-second drop lifetimes. | MP-11 Rust and Chrome restarted while both deadlines were still in the future. The ten-item corpse and loose rifle returned with their original deadlines. Both expired and left the rendered discovery feed. The corpse model and Use prompt disappeared, and the locker retained its item. | The harness seeded positions and sent the ordinary drop command directly over WebRTC. MP-04 separately verified the original Drop binding. SQLite polling observed deletion within 1.2 seconds of each deadline. [Full-loss evidence](acceptance/native-locker-full-loss.json) |
| 2026-11-09 | Optimized Rust and two Chrome processes, stock Zaton and a mixed Groza magazine at 94 m. | MP-07 the lower shot struck cover and the elevated shot hit, reducing health from 100 to 86. The same measured low aim would hit with the straight ray. Both rounds spent once and SQLite retained eight rounds. A separate worker probe loaded and debited both stock Gauss profiles. | The harness seeded positions and scripted camera motion. A shared headless browser stalled during the final retest. Separate processes passed with zero WebGPU validation errors. This case used stationary targets. [Firearm ballistics](acceptance/native-owned-ballistics.json) |
| 2026-11-09 | Optimized Rust and three isolated Chrome processes on stock Zaton, mixed TOZ-34 load at 7.5 m. | MP-07 the slug hit the left player and left the right player at full health. One buckshot shell damaged both, with final health 17 and 0. SQLite retained two weapon revisions, five outfit revisions on the survivor, and the dead player's six-item corpse. A separate injected failure at the second victim rolled back the entire shell. | The harness seeded positions and scripted camera motion. Headless focus changes logged pointer-lock warnings. The original fire inputs and all three renderers passed with zero WebGPU validation errors. NPC batching was checked at the Rust queue boundary. [Buckshot evidence](acceptance/native-owned-buckshot.json) |
| 2026-11-09 | Optimized Rust and two Chrome processes, stock Zaton, mixed TOZ-34 load across two glass faces at 5 m. | MP-07 buckshot stopped at the panel. A slug fired at the same aim crossed the two faces and took the target from 100 to 67 health. SQLite retained one victim condition revision and two weapon revisions. | The harness seeded poses and scripted camera motion. Density loss was tested in a synthetic fixture, while the rendered glass has zero authored density. Both renderers had zero WebGPU validation errors. [Material cover](acceptance/native-owned-material-cover.json) |
| 2026-11-09 | Optimized Rust and two Chrome processes, stock Zaton and one grazing TOZ-34 shot. | MP-07 both clients saw a fatal ricochet. SQLite recorded the round debit and seven-item corpse. The grounded fixture hit in 24 of 24 traces with ricochet enabled and zero of 24 without it. | The browser used seeded positions and scripted camera motion. Material impact presentation remains open. [Ricochet evidence](acceptance/native-owned-material-cover.json) |
| 2026-11-09 | Optimized macOS ARM64 A-Life host, release Rust and two Chrome WebGPU processes, local stock Zaton. | MP-19 a stock Gauss round at 150 penetration crossed the private hit bridge. Both browsers received the same NPC death at tick 1212. SQLite preserved one shot and zero remaining rounds. | The harness seeded player poses and ammunition and spawned a stock stalker. The shot used the original Mouse1 binding. [Native firearm evidence](acceptance/native-alife-player-attacks.json) |
| 2026-11-09 | Same optimized native host, Rust and two Chrome processes on stock Zaton, one TOZ-34 buckshot shell. | MP-07 and MP-19 the first native pellet acknowledged 91 health. Both browsers received the same snapshot at 6 health on tick 1108. SQLite retained one shell debit. | The harness seeded poses and ammunition and spawned a stock stalker. The original Mouse1 binding fired once. [Native buckshot evidence](acceptance/native-alife-player-attacks.json) |
| 2026-11-09 | Optimized Rust, two Chrome WebGPU processes and stock Skadovsk west boundary. | MP-12 the defender took damage outside and while locked inside, could not fire from safety and regained protection after expiry. Protected logout took 210 ms. A vulnerable reconnect reclaimed the same body, a separate body expired after 55.025 s, and an offline body was restored and killed after Rust restarted. SQLite retained an eight-item corpse. The original Enter binding granted six items for the new life. | The harness seeded poses and pistols, scripted aim and used test timers. Both renderers reported zero WebGPU validation errors. This build reset the camera heading on reopen. The following run verifies the fix. [Rendered logout evidence](acceptance/zaton-vulnerable-logout.json) |
| 2026-11-09 | Optimized unified WASM, two Chrome processes and local Rust on stock Zaton. | MP-12 initial join, protected reconnect, same-body reconnect and server-restart recovery restored nonzero heading and crouch. The first input and native camera heading matched the server pose. MP-01 the same binary saved and reloaded a campaign with F5 and F9, with zero multiplayer requests. | Warm browser profiles and seeded starting poses. Both multiplayer renderers and the campaign renderer had zero WebGPU validation errors. [Saved pose and campaign evidence](acceptance/zaton-vulnerable-logout.json) |
| 2026-11-09 | Optimized unified WASM and three isolated Chrome processes, local stock Zaton. | MP-17 the nearby observer received five outfit, helmet and rifle updates in 39–112 ms. The distant client spawned, removed and respawned the actor across the 100 m boundary, with current gear on return. A fixed eastward walk and the AK-74 muzzle 0.81 m ahead confirmed the yaw conversion. | The harness seeded poses and gear, used the normal inventory protocol for clothing and the original controls for weapon actions and movement. The headless focus change logged a pointer-lock warning. All three renderers had zero WebGPU validation errors. [Rendered equipment evidence](acceptance/native-equipment-visibility.json) |
| 2026-11-09 | Optimized unified WASM, Chrome WebGPU and Rust on stock Zaton. | MP-13 passed native crouch, walk, run, sprint, stock pickup, carrying limits, four quick-use doses, and a clean restart with the same life, equipped gear and active boosts. The same build passed single-player F5/F9 with zero multiplayer requests. | The fixture seeded quick-slot assignments, gear and condition. The first restored-control run sampled prediction during warmup. A full fresh-save repeat waited for initialization and confirmed prediction active. Native and WASM matched on 25 routes. The earlier movement build supplied full-duration expiry and inventory screenshots. [Survival loop evidence](acceptance/native-survival-loop.json) |
| 2026-11-09 | Optimized unified WASM, Chrome WebGPU and Rust on stock Zaton. | MP-14 passed keyboard entry, gear mitigation and wear, belt protection, stock quick-use medicines and HUD shields, restart, full 60-second radiation protection expiry, and eight-item corpse transfer. The same build passed single-player F5/F9 with zero multiplayer requests. | Earlier fixture attempts overlapped neighboring fields or placed the psy test inside a field during startup. The final runs entered from surveyed positions outside the fields. [Continuous field evidence](acceptance/native-continuous-fields.json) |
| 2026-11-09 | Optimized unified WASM and Rust, Chrome WebGPU and stock Zaton Electra 255. | MP-15 passed quick and charged bolt flight, the stock flash and particles, positional samples consumed on both views, damage on reentry, gear wear, full-loss death, Skadovsk throw refusal and exact restart recovery. The same build passed single-player F5/F9 with zero multiplayer requests. | The test seeded stock equipment and surveyed starting poses. A third renderer stalled in the initial test. Refusal and restart used one browser renderer at a time with the same saved world. [Rendered Electra evidence](acceptance/native-electra.json) |
| 2026-11-09 | Optimized unified WASM and Rust, Chrome WebGPU and two authored Zaton sites. | MP-16 rendered all four stock handheld detectors. Echo filtered Night Star. The Crystal pickup race had one winner at 99 ms between requests. That player recovered the same Crystal after Rust restarted and belted it. The disposable condition test rejected 1% and accepted 1.01%. MP-01 F5/F9 passed on the follow-up build. | Gear and poses were seeded. The browser removed the stowed detector's last reveal after 6.279 s including polling. The first comparison associated stretched geometry with the revealed Night Star. The later comparison isolated it to player overlap. [Rendered detector evidence](acceptance/native-detectors.json) |
| 2026-11-09 | Optimized unified WASM and Rust, Chrome WebGPU at surveyed positions on the stock Crystal site and Night Star waypoint. | MP-16 passed eight inside and outside reveal checks and Echo and Bear AudioWorklet playback. The same view cleared its stretched geometry when a retained remote body expired, while Night Star remained visible. | The apparent artefact issue in the first fixture came from player overlap. The first native belt click sent absolute motion while pointer lock required relative motion. [Rendered detector evidence](acceptance/native-detectors.json) |
| 2026-11-09 | Final optimized unified WASM and Rust, Chrome WebGPU and the same stock Zaton save after restarting Rust. | MP-16 Night Star survived pickup and restart in the rucksack. A native inventory double-click placed the exact item in belt cell zero with condition 100%. | The retry used the engine's relative cursor. The two-player pickup race and the native belt click used separate artefacts. [Rendered detector evidence](acceptance/native-detectors.json) |
| 2026-11-09 | Optimized Rust with schema 4, two Chrome WebGPU clients on stock Zaton, plus five-map startup. | G-02 verified Svarog's stock anomaly icons and Night Star together, a 30.61 m center within the zone's bounding-sphere range, an inactive-layer exclusion at 7.70 m, Veles isolation and cue removal on stow. Rust loaded 521 markers and two exports were byte-identical for each map. MP-01 F5/F9 passed. | Browser coverage used seeded Zaton detector gear. Gameplay effects for additional reactive families and emission layer changes remain under G-07. [Svarog evidence](acceptance/native-svarog-anomalies.json) |
| 2026-11-09 | Optimized unified WASM and Rust with stock Zaton ladder and reload timing exports, Chrome WebGPU. | G-02 verified the stock fast stow and redraw through a 2.368 s Makarov reload and attachment to authored ladder 6. Rust paused the private cue and preserved the existing reveal deadline. Manually stowing on the ladder held after exit until O was pressed again. MP-01 F5/F9 passed. | Gear and initial poses were seeded. The rendered checks covered one firearm and one ladder. Firearm zoom remains open. [Interlock evidence](acceptance/native-detector-interlocks.json) |
| 2026-11-09 | Optimized unified WASM and Rust, Chrome WebGPU and stock Zaton. | MP-07 and MP-08 rendered stock Makarov ironsight and SVD scope. Each shot spent one round, and the scope stayed raised through its new ammo revision. G-02 verified fast stow, reveal expiry while aimed, fast redraw on release and reload cancellation of aim. MP-01 F5/F9 passed on the same build with zero multiplayer requests. | Gear and poses were seeded. The first scripted detector scan stopped on an inventory-busy reply. The final run handled busy replies and verified the existing reveal expired. Fixed optics and stationary aim were covered. [Aim evidence](acceptance/native-firearm-aim.json) |
| 2026-11-09 | Optimized Rust and unified WASM on stock Zaton, local Chrome WebGPU. | MP-07 Makarov hip cone increased 35% under pitch motion. Fully raised sights used the fixed actor term. An Abakan held for 0.88 seconds spent nine rounds across 26 ticks, past the 300 ms lease, and stopped on release. MP-01 F5/F9 passed on the same staged client. | One client with seeded gear and pose. The first run sent reload while the presentation worker still had the previous active slot. Rust rejected it. The passing run waited for the native draw. [Turn and trigger evidence](acceptance/native-firearm-turn.json) |
| 2026-11-09 | Optimized Rust and unified WASM on stock Zaton, local Chrome WebGPU. | MP-06 switched between the Makarov and Abakan and immediately reloaded each. The HUD played both stock motions. A separate run spent the last compatible cartridge, removed its box, rejected another reload and preserved the incompatible ammunition and exact magazine after Rust restarted. MP-01 F5/F9 passed with zero multiplayer requests. | Gear and poses were seeded. The harness held the first engine selection reply to exercise the stale-slot window. The second switch used the normal reply. [Switch and ammunition evidence](acceptance/native-weapon-switch.json) |
| 2026-11-09 | Optimized Rust and unified WASM, local Chrome WebGPU and stock Zaton. | MP-08 fitted and removed all three LR300 addons through the original inventory menu, rendered the SUSAT reticle and M209 flight and impact, and preserved four rifle rounds. A second reload and detach returned the exact launcher and one grenade. A bare Abakan rendered without a scope. MP-01 F5/F9 passed on the same WASM. | The fixture seeded stock parts and positions. Initial runs found the class-ID mismatch, cached-bone visibility bug and launcher replication filter. Rejected attachments were checked directly over the binary channel. [Rendered attachments](acceptance/native-attachments.json) |
| 2026-11-09 | Optimized Rust, unified WASM and two Chrome WebGPU instances on stock Zaton. | MP-17 the observer saw each fitted or removed LR300 attachment through the original menu, no drawn parts while holstered, all parts after redraw and the current view on reconnect. The public descriptor exposed only appearance. MP-01 F5/F9 passed on the same build. | Stock gear and poses were seeded. The observer was 4.5 m away. Slung weapons remain open. [Rendered remote attachment evidence](acceptance/native-remote-addons.json) |
| 2026-11-09 | Optimized Rust and two Chrome WebGPU processes on stock Zaton, with the same unified WASM as the preceding single-player run. | MP-03 both original Use commands reached Rust on tick 762, 0.325 ms apart at browser submission. One won. The stock box survived native Drop and re-loot with the same ID and 60 rounds, and two server restarts left one owner. | Grounded poses were seeded on either side of authored spawn 1183. SQLite confirmed one item row, an empty authored source and a clean integrity check. [Same-tick evidence](acceptance/native-loot-race.json) |
| 2026-11-09 | Same optimized build, two Chrome WebGPU processes on stock Zaton at authored stash 18. | MP-05 the empty stash survived a restart, both cooldowns, and one player leaving. The second player walked away and one SVD refilled the stash. Another restart preserved the exact SVD and kept the one-time loose source empty. | The disposable fixture seeded grounded poses and used a 90-second cooldown, 6 m exclusion plus the server movement margin, and one-item cap. The first browser used a third save to collect the one-time box in the same database. [Two-player stash evidence](acceptance/native-stash-refill.json) |
| 2026-11-09 | Same optimized build, stock Zaton and local Chrome WebGPU with both compatible ammunition types for the Makarov and Abakan. | MP-06 the original Y key reached only the newly selected weapon. The Makarov exchanged four FMJ rounds for eight PMM rounds and the Abakan exchanged 15 FMJ for 30 AP rounds. Exact magazines, revisions and reserves survived a Rust restart. | The fixture seeded stock gear and one grounded pose. The harness held the first engine selection reply, then used ordinary reply timing for the second switch. Other firearms remain in scope. [Next Ammo evidence](acceptance/native-next-ammo.json) |
| 2026-11-09 | Optimized unified WebGPU WASM and Rust, two Chrome processes on stock Zaton. | MP-10 stock first-person and observer motions played for both knife modes, with matching HUD and positional Worklet samples. Both attacks missed at 4.63 m, stopped at stock glass and respected Skadovsk protection. The close strike comparison, seven-item corpse and Rust restart passed. MP-01 F5/F9 resumed the campaign with zero WebGPU validation errors or multiplayer requests. | The local fixture seeded grounded poses and stock armour. The first trial duplicated the starter knife. A later trial exposed the whole-body animation API return value and the candidate was rebuilt. Player hit impulses remain open. [Knife and single-player evidence](acceptance/native-knife-presentation.json) |
| 2026-11-09 | Optimized unified WebGPU WASM and Rust on stock Zaton with two rendered clients for smoke and three for blast cover. | MP-09 stock quick, charge and cancel inputs worked. Both smoke models drew and their positional audio played without damage. Stock F1 and RGD-5 landed in the same place, wore exposed exoskeletons, respected cover and restored the selected pistol. The protected F1 stayed equipped. MP-01 F5/F9 passed on the same WASM with zero multiplayer requests. | Disposable saves seeded stock gear and surveyed poses. The first F1 audio probe stopped before the observer consumed a sample. The isolated retry captured both Worklets. Stock spin, fragments and blast impulse remain open. [Grenade and single-player evidence](acceptance/native-grenade-presentation.json) |
| 2026-11-09 | Optimized unified Chrome WebGPU and release Rust on stock Zaton, with a server restart. | MP-04 alternate weapon slots, helmet and sealed suit, exact belt cells, mixed stacks, single drop and recovery after a lost Drop All reply passed. MP-01 stock F5/F9 also passed on the same browser build. | [Run evidence](acceptance/native-mixed-inventory.json) · [Helmet](acceptance/native-mixed-inventory-helmet.jpg) · [Stacks](acceptance/native-mixed-inventory-stack.jpg) · [Reconnected inventory](acceptance/native-mixed-inventory-reconnect.jpg) |
| 2026-11-09 | Public Fly Zaton release from `53531f20`, unified browser release `0c59684d`, fresh Chrome profile. | Hosted smoke passed. The client received 21 authoritative snapshots per connection and recovered the same six starter items after resuming its save. The public entry served the unified release and the fresh-profile Extreme and 1920×1080 config. | Transport and release checks only. MP-02 still calls for a changed inventory, a separate profile and a hosted restart. [Public alpha](https://stalker-online.xyz/) |
| 2026-11-09 | Optimized macOS ARM64 X-Ray and release Rust, stock five-map campaign, two local WebRTC clients. | All five native hosts admitted and persisted a checkpoint. The Zaton-to-Jupiter crossing moved the traveller between native feeds, retained all six exact items and left the observer in Zaton. Restarting only Jupiter recovered checkpoint 1. | [Multi-map A-Life and travel](acceptance/native-alife-campaign.json) |
| 2026-11-09 | Public Fly Zaton, optimized Linux X-Ray, release Rust and Chrome WebRTC. | MP-19 public transport smoke passed. Chrome received 18 stock NPCs and observed three moving. The native save and SQLite admission advanced to checkpoint 2. All prior player identities were present. | [Hosted native A-Life evidence](acceptance/native-alife-fly-zaton.json) |
| 2026-11-09 | Optimized Linux x86-64 on an isolated Frankfurt Fly Machine with eight shared CPUs and 12 GiB of RAM. | All five native hosts saved checkpoints. The campaign kept the existing test Zaton lineage and save identity. Two WebRTC clients verified the Zaton-to-Jupiter crossing and exact inventory. Killing Jupiter forced an independent restart and a new durable checkpoint. | [Five-map Linux Fly evidence](acceptance/native-alife-fly-campaign.json) |
| 2026-11-09 | Public five-map Fly campaign, optimized Linux x86-64 and unified browser release `ad2fef3a`. | All five hosts persisted and registered checkpoints. Zaton retained its lineage and all 39 existing player records survived. Chrome reconnected with the same six items and observed 16 stock NPCs, including two moving. The published fresh-profile preset is Default at 1920×1080. | Rendered travel and 200-player capacity still need checks. [Public campaign evidence](acceptance/native-alife-fly-campaign-public.json) |
| 2026-11-09 | Optimized native X-Ray and Rust, Zaton with a WebRTC fixture and disposable saves | MP-06 verified stock AK-74 and SPAS-12 capacity despite different Rust catalog values, one commit per shell, and an isolated Groza launcher reload. | Rendered checks, upgraded weapons and broader ammo coverage remain open for the native host. [Native reload rules](acceptance/native-reload-rules.json) |
| 2026-11-09 | Optimized native X-Ray and Rust, isolated Zaton WebRTC fixture | MP-06 through MP-08 verified native impact and wear for mixed SPAS-12 rounds, a suppressed LR300, and four AK-74 PvP hits. The Groza launcher reload regression passed. | The Rust fixture catalog had zero damage. Rendered comparisons and native projectile flight remain open. [Native cartridge impact](acceptance/native-cartridge-impact.json) |
| 2026-11-09 | Optimized native X-Ray and Rust, isolated Zaton WebRTC fixture | MP-07 and MP-08 verified stock shotgun pellet counts, LR300 suppressor velocity, Abakan opening velocity and four AK-74 hits beyond the altered Rust catalog range. | Rust committed one debit per shot. Rendered checks and moving projectile flight into X-Ray remain open. [Projectile cutover](PLAN.md#player-combat-cutover) |
| 2026-11-09 | Optimized native X-Ray and Rust, isolated Zaton WebRTC fixture | MP-07 and MP-08 verified Abakan opening spread, SPAS-12 buckshot and slug spread, suppressed LR300 spread, and stock gravity and ricochet energy. | A moving-target rerun committed four hits against native bones across five accepted AK-74 shots. One earlier run used fallback hit geometry for a moving contact. [Projectile cutover](PLAN.md#player-combat-cutover) |

### Shared native projectile trajectory (2026-11-09)

Engine and Rust now call the same X-Ray trajectory position and impact-velocity
functions. This removes Rust's assumption that impact velocity remains equal
to the position derivative after the stock drag transition. The engine's
separate 1/drag and 2/drag transition times are retained.

Manual checks pending: compare close and distant rifle hits, steep uphill and
downhill shots, vertical shots, buckshot, and penetration/ricochet on thin cover.
Confirm one ammo debit per accepted shot, no duplicate wounds, and working
single-player weapon effects. These checks have not been performed in a rendered
game for this change.

Still omitted from this cutover: native ownership of collision traversal, dynamic
cover, delayed projectile arrival and native weapon action state machines. Rust
still selects bounded chords and traces rewind snapshots before durable commit.

Validation: all 160 Rust tests passed, including drag-transition impact velocity,
zero drag, vertical launch, range-limited contact speed and fast Gauss flight.
Optimized native X-Ray, WASM/browser and Rust server builds passed.

### Native skeleton collision queries (2026-11-09)

Rust rewind now calls X-Ray's RAYvsOBB, RAYvsSPHERE and RAYvsCYLINDER
routines. Skeleton queries share a header with the engine. Cylinder and vector
math compile from engine sources. Historical pose selection and native geometry
freshness checks remain in Rust. Missing/stale geometry still uses a capsule.

Targeted tests cover rotated boxes, cylinder walls and caps, tangent spheres,
inside-origin culling, strict range limits, named bones and rewind translation.
Manual tests pending: moving-player head/limb shots, crouched targets, targets
near cover, and single-player combat after the source extraction. No rendered
combat verification was performed for this change. Native world collision
traversal, dynamic cover and NPC broad-phase selection remain migration work.

A separate WebGPU fix restores engine framebuffer bindings after presentation.
Its regression reproduces the reported attachment exception while deletion
flushes queued state. Manually check the action which previously triggered that
crash, including transitions that release render targets.

Validation: 161 Rust tests and 55 WebGPU tests passed. Optimized native,
WASM and Rust builds passed. The staged Fly source context compiles the new
collision adapter and engine vector math locally. Local 8137 multiplayer
server/native host refreshed with its saved world. Local 8132 release
`37dfd12ff5732e33ba1dc199b4fa4f8b39e45f93ef3a40debcd22736c5545169`
contains the framebuffer fix and rebuilt engine. Headless Chrome verified its
engine installation and cached WASM hash. Production was not deployed.

### NPC animated collision-form cutover (2026-11-09)

Nearby living native NPCs now export their stock skeleton collision forms using
the same serializer as player actors. Rust binds each sample to the active host,
server epoch, native NPC ID and spawn generation, rejects samples older than
five ticks and duplicate/out-of-order samples, and retains the shapes in rewind.
NPC candidate selection uses these shapes when fresh. Native terminal hit
confirmation and native damage application are unchanged.

Sampling is bounded to 64 NPCs per roster frame, within 100 metres of player
interests. Candidate ordering rotates and writes are nonblocking. Outside this
coverage, or after expired samples, model-box selection remains a fallback.
This is not a complete native bullet-manager/world-collision cutover.

Manual checks pending: fire through visible gaps around NPC limbs, compare
human and mutant silhouettes, moving NPCs, close cover and dead/respawned NPCs.
Do not count these checks as completed by packet or geometry tests.

Validation: 162 tests passed in the full Rust suite, followed by one additional
passing combat regression proving skeleton gaps miss and historical NPC pose
hits survive movement. Optimized native X-Ray and Rust server builds passed.
The local multiplayer preview was refreshed with the existing saved world.

### Shared native material response (2026-11-09)

X-Ray and Rust now compile the same penetration/ricochet decision routine and
density speed-loss calculation. The native caller retains original random-number
consumption and effects. Rust retains deterministic shot sampling, tracing bounds
and transactional damage. Magnetic penetration may become negative internally
as in X-Ray; outgoing authoritative damage carries zero for exhausted penetration.

The cutover also aligns the exact material transparency epsilon boundary, which
Rust previously treated as transparent. Regression checks cover transparent
materials, stop/ricochet flags, magnetic priority/depletion and density exhaustion.
All 164 Rust tests passed after this change.

Manual checks pending: foliage, solid walls, thin cover, grazing ricochets and
Gauss shots through successive surfaces. Full native world collision traversal
and dynamic-cover authority remain open.

### Direct WebGPU detail instancing local release (2026-11-09)

Local 8132 release `b6bc9bf56bffcaddb7a266f6518fb5184368cae8542b1480ac8ad414cdc0dce2`
includes shared material response, the framebuffer restoration fix, detail
instancing, instance-data reuse and bulk vec4 uniform uploads. The original
asset pack is unchanged. Optimized native/browser/Rust builds passed.

Renderer validation: 58 WebGPU tests, 16 real-GPU detail shader variants and
130 instances per draw with 520 checked pixels across buffer replacements.
This does not establish gameplay FPS or replace manual scene checks.

Manual rendering checks pending: original max-graphics terrain and ground views,
wind/static details, sun shadows, visibility-boundary movement, graphics reset,
and level travel/reload. Capture the new detail preparation/submission counters
with frame and GPU timings. Use the supplied Chrome trace as baseline.
Full investigation and implementation notes are in
`misc/web/webgpu/TERRAIN-PERFORMANCE-2026-11-09.md`.

### Shared weapon reload decisions (2026-11-09)

Magazine-fed weapons, shotgun ammunition fallback, next-ammunition cycling and
the Rust inventory transaction now use the same X-Ray selection routine. The
stock magazine type-switch/unload predicate is also shared. Rust supplies an
availability snapshot read inside the inventory transaction and still commits
all box/magazine changes atomically.

Validation: 166 Rust tests passed, including selected-type priority, authored
fallback order, locked refill, next-type wraparound, no-compatible-ammo cases,
round conservation, mixed shotgun shells, launcher separation and action replay.

Manual checks pending: switch ammo on partly loaded/full rifles, reload from
several boxes, mix shotgun shells, clear jams and interrupt/restart reloads.
This cutover does not implement native animation callbacks or replace Rust's
reload scheduling. Those native weapon state transitions remain open.

### Follow-up cache correction and reload build (2026-11-09)

Local 8132 release `0e543b811c294750d302bcf1819ce3a0fd6b4b0346409227f8181d319d2e5886`
includes the shared reload decisions and corrected detail-instance cache.
The second supplied trace confirmed the instanced build was active but showed
a 50.36 ms frame-callback median over seconds 10–18. Uniform conversion improved,
while detail packing and uploads dominated. Unconditional per-frame cache
invalidation was fixed using ordered visibility comparison and tracked content
changes. Moving views or slot decompression can still invalidate all batches.

Validation: 166 Rust tests, 59 renderer tests and optimized native/browser/Rust
builds passed. The cache regression verifies 100 unchanged frames avoid repeated
uploads and that relevant mutations invalidate reuse. Local release hashes were
verified. No post-correction gameplay FPS measurement has been made.

Manual checks pending: hold the same max-quality terrain view stationary, then
move/rotate, check wind and shadows, and capture FPS/render time plus detail
preparation/submission/reuse counters. Use the prior two traces as baselines.

### Shared shotgun reload animation transitions (2026-11-09)

X-Ray and Rust now use the same open/insert/end animation transition routine.
An interrupted insertion commits one shell, retains the current animation's
deadline and finishes when it ends. The previous Rust flow played an extra close
animation after that deadline, unlike stock CWeaponShotgun::Action and
OnAnimationEnd. Normal end-of-reload still plays its close animation.

Validation: 167 Rust tests passed, including the interrupted-phase regression
and existing ammo-conservation, mixed-shell, jam and replay checks.
Manual checks pending: interrupt during opening versus insertion, interrupt
near the insertion deadline, normal full-tube completion, exhausted reserve,
weapon switching, death and reconnect. Verify exactly one current shell is
inserted and no extra closing delay follows fire interruption.

Still open: native-host ownership of the full weapon state machine. Rust retains
wall-clock scheduling, durable transaction acknowledgement and session checks.

### Shared environmental condition damage (2026-11-09)

- Radiation must increase radiation without an immediate health/stamina hit from the pulse itself. Later radiation sickness remains part of the condition tick.
- Psy exposure must affect psy health and health/stamina; chemical, heat and shock pulses must not create bleeding wounds.
- Compare exposure with and without protective equipment and a protection booster. Re-enter the field after expiry; safe-zone policy must still gate harmful exposure.
- Compare single-player environmental hits after the shared-kernel refactor, including heat hits on different bones. Native heat retains bone health scaling; continuous multiplayer fields have no bone and use scale 1.

These rendered checks remain **manual / not run**. Optimized native, browser and Rust release builds pass; the idle local multiplayer preview was refreshed and its saved Zaton world clock resumed. The full server suite passes 169 tests. Automated kernel checks cover all five hit kinds, protection before immunity, complete absorption, heat-only bone scaling and signed immunity-booster deltas. Both engine and Rust use the same C++ implementation. This is not completion of native condition-tick ownership: the Rust field scheduler, catalog coefficients and persistent condition state remain, and native immunity boosters are not yet mirrored.

### Native physical-hit condition proposals (2026-11-09)

Native NPC melee, firearm, explosion and player collision proposals now carry final health/stamina losses from the actor's stock physical-hit calculation. Armour reduction and condition coefficients are evaluated in X-Ray; Rust authorizes and commits the proposal with gear wear. Invalid or stale proposals retain the existing fallback behavior. The private host packet is ZAH4; native host and Rust must be updated together.

Manual checks remain unrun: compare NPC melee/firearm/explosion and fall damage with original actor settings, with and without armour; verify safe-zone protection, lethal-hit corpse ownership and reconnect after equipment changes. Wound randomization/scaling, native condition ticking and medicine/booster ownership remain open.

Validation: 169 Rust tests pass after the ZAH4 change. The equipment transaction regression deliberately uses different reduced, health and stamina values and verifies the native final values commit atomically; rollback and stale-generation fallback remain covered. Packet checks reject nonfinite/negative/excessive deltas and the old proposal layout. Optimized builds are in progress; no deployment or rendered verification is claimed for this change yet.

### Lossless native condition checkpoint (2026-11-09)

`ZoneConditionState.h` defines the bounded ZCS1 host checkpoint. Standalone codec checks pass with:

```sh
c++ -std=c++17 -Wall -Wextra -Werror -Isrc server/tests/native_condition_checkpoint.cpp -o /tmp/zone-condition-checkpoint-test
/tmp/zone-condition-checkpoint-test
```

Checks cover 1,000 byte-exact round trips, tiny wounds, the full 16-bit bone ID, maximum wound count, duplicate wound/booster rejection, invalid medicine duration, nonfinite values, every truncation length, trailing data and hostile counts. Actor restore replaces booster-derived values rather than applying boosters repeatedly. This is codec evidence only; the request/persistence bridge and live actor restore/retry verification remain unimplemented/unrun. The native actor's equipment timer is now per actor and checkpointed. When the bridge is enabled, manually compare two players with different belt equipment, retry/reconnect during a booster and treatment, and verify neither player changes the other's effect cadence.

The checkpoint test now also covers the native ZCT1/ZCU1 envelope and the production replay cache: baseline request, mandatory checkpoint for a nonzero step, excessive timestep, identical retry, altered same-sequence request and old sequence. These tests do not prove live actor restoration or database commit fencing. Once connected, test repeated delivery, disconnect during a pending step, equipment change while awaiting a reply and host restart; no condition delta or booster may apply twice.

Rust-side condition handoff checks (171-test suite): all host/player/revision/equipment fence mismatches and truncated replies are rejected; native checkpoint JSON/SQLite round trips preserve exact bytes; a stale equipment generation cannot commit; repeating a committed revision cannot apply it twice. Optimized native build passes. This does not yet validate live scheduling or replace Rust's condition simulation. The persistence operation is currently exercised by tests, not sent by gameplay peers.

Native baseline acquisition is now connected to live equipment synchronization. The private Unix socket regression passes: request/reply delivery, changed equipment with delayed old reply, and player-incarnation cache retirement. This tests transport/lifecycle with a fixture endpoint, not the actual X-Ray actor calculation. Baselines remain templates and do not overwrite a player's saved condition. Saved-state conversion, live native condition stepping and rendered checks remain outstanding.

Initial condition-import checks pass: exact named wounds (including small floats), ongoing medicine effect/duration fields, mapping of bleeding-restoration boosters to the native enum, legacy scalar bleeding, invalid bone-name characters, every truncated payload and rejection of time advancement during import. Native actor import resolves actual bone IDs and applies stock booster functions. The actor-level round trip and live import commit are not yet verified. When enabled, test switching from an existing save with bleeding, an active medkit and an active weight booster; verify no reset, duplicated boost or timer restart.

### Native timed medicine and headless policy isolation

The explicit host condition step now advances imported timed medicine in real seconds, matching booster timing, and applies each elapsed fraction through `CEntityCondition::ApplyInfluence`. The last fraction is clamped to the remaining duration. Standalone checks cover partial doses, exact completion, an oversized final step, exhausted treatment and invalid duration. The normal single-player scheduler is unchanged. Host-owned actors also ignore local god-mode flags in satiety and hit handling while retaining `CanBeHarmed` policy.

This does not enable live condition ownership: peer scheduling, native hit/treatment mutations, and stopping the duplicate Rust tick remain required. Manual verification once enabled: import an active treatment, reconnect mid-treatment, and confirm no duration reset or double dose; check safe-zone protection separately from local debug flags. Actor-level runtime verification remains pending.

### Native consumable proposals

ZCM1 requests carry a validated checkpoint and a bounded configuration section name, with zero elapsed time. The native actor executes the same `ApplyConsumableEffects` function now used by `CEatableItem::UseBy`: stock medicine application followed by configured boosters. Immediate deltas are resolved without ticking medicine/booster timers; timed treatments remain in the checkpoint. Host actors suppress local use sounds. Missing required section fields are rejected before mandatory engine config reads. The host captures the result and restores its mirror; existing sequence/revision/equipment fences and replay caching apply.

Standalone protocol checks pass for exact checkpoint/section decoding, missing checkpoint/section, invalid section characters, oversized names, bad lengths and nonzero elapsed time. All three targeted Rust condition tests pass, including consumable request/reply validation. The optimized native build has compiled ActorCondition, EntityCondition and eatable_item successfully; the complete link is still running. This is not yet connected to the inventory consume transaction: the remaining cutover must commit item use and the resulting checkpoint atomically, preserve custom thirst, and prevent any legacy effect application after native ownership. Manual cases remain pending: food, instant medkit, timed medkit, bandage, antirad, replacement booster, active medicine rejection semantics, retry and reconnect during consumption.

### Atomic native consumption persistence

`ConsumeNative` is an internal session-only persistence operation. It uses the existing inventory command authorization, item revision and durable request ledger, verifies the native proposal's item section and equipment generation, then writes its checkpoint and decrements one item portion in the same SQLite transaction. Condition revision changes reject the result. Stock medicine/booster effects are not applied again in Rust; configured custom hydration is applied once at consumption. Legacy consumption explicitly rejects native-owned checkpoints. Loadout generation/notification handling includes the native operation.

The integration fixture verifies wrong-generation, wrong-section and wrong-condition rejection with unchanged inventory/state, exact native health/checkpoint preservation, a single portion/revision change and identical retry results. It also injects a failure after condition update but before item debit to verify atomic rollback. Peer scheduling and native condition ownership are still not enabled, so this transaction is currently exercised by the test fixture only. Live replay/reconnect and all rendered consumption cases remain manual checks after cutover.

### Compute-gather grass renderer checkpoint — 2026-11-09

Local8132 release `94dddce88ca36f7dcdec8a2b12fc4384b509e437ea39bbf2b41a6656fdd9e415`
uses persistent slot/class GPU records and compute gathers into the original
instanced vertex layout. Source, visibility order, wind, lighting and shadow
math remain stock; no grass quality/distance reduction. No production deploy.

Automated: optimized browser build,63renderer regressions, all16stock detail
shader variants,1300hardware-checked pixels, source revision/allocation/pool
reuse, pending-pass ordering and page-growth/eviction tests pass. Local release
hashes include the new `detail-storage.js` module.

Authorized isolated hardware gameplay check at1920×1080,maximal grass density,
radius300,height2,geometry2,sun details on: stationary156.47FPS; continuous
camera turn101.21FPS (previous span build28.82),turnp9515.88ms,p9918.43ms,
zeroGPUerrors. Stationary throughput was slightly below prior163.05FPS; these
are retained-run comparisons with live simulation/weather, not strict identical
GPU work. See `misc/web/webgpu/TERRAIN-PERFORMANCE-2026-11-09.md` for evidence.

Still manually check: other terrain/levels, multiplayer, grass wind/static
variants and shadows during camera/visibility transitions, graphics-device reset,
level reload/travel, and long sessions which force source-page eviction. The
short benchmark and synthetic lifetime tests do not certify all scenes or promise
100FPS everywhere. Keep maximal Advanced grass settings when comparing results.

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

### Native condition / queued firing handoff (pending cutover testing)

After native-condition bootstrap is enabled, hold fire while stock condition updates and timed medicines are active. Shots must not disappear with an inventory-busy response or starve until the two-second queue timeout. Condition timers must catch up after firing. Repeat reciprocal fire and a shotgun volley, disconnect/reconnect while a native hit commit is pending, and verify no duplicated ammo debit, wounds, corpse or equipment wear. These are pending integration/manual cases; current native Release and Rust suite passes do not establish live gameplay completion.

### Native physical hit batch acceptance (pending integration)

Once firing uses native batch proposals, test a shotgun against an armoured actor with pellets hitting different bones. Wear from earlier pellets must affect later pellets; a lethal pellet must prevent subsequent hits from creating additional corpses. Retry/lost-response testing must preserve one ammunition debit and one victim condition commit. Compare against sequential native stock hits. Protocol validation is automated; actor-level equivalence and live firing are still unverified.

Native firearm persistence automation now covers a two-victim rollback, complete checkpoint preservation, one ammunition debit, corpse ownership and stale round/equipment/condition fences. Live native firing scheduler integration and X-Ray batch-versus-sequential actor verification remain pending. Do not treat the database fixture's supplied native result as proof of native damage calculations or rendered multiplayer behavior.

### Native firearm coordination (integration pending)

The live scheduler now has a native firearm proposal path for checkpoint-owned victims. During testing, fire reciprocal shots and multi-victim shotgun volleys while medicine/condition updates are active. Disconnect the shooter during native resolution, expire held fire, and restart the native host: pending shots must either complete once or cancel without debit, and every victim must regain inventory/condition updates. Automated disconnected-shooter cancellation passes. Automatic bootstrap remains disabled and these live cases are not yet verified.

### Native condition housekeeping

After cutover, test reload during active condition timers, periodic location persistence, vulnerable logout, safe-zone logout and graceful shutdown. After the final save, no fresh autonomous native condition tick may overwrite it. Queued damage must finish before that save; native actors must never enter the legacy hit/field handlers when housekeeping runs. Automated scheduler coverage now checks checkpoint handoff, pending damage priority and death queue retirement; live reload/logout/shutdown verification remains pending.

### Native melee cutover tests (live verification pending)

Test direct slash, direct stab and off-axis splash hits against armoured players. Check health, power, wounds, belt artefacts and armour wear against native X-Ray behavior. Changing equipped weapon or attack mode while a native result is pending must reject stale work. Native result persistence now has automated mode-binding, rollback and full-checkpoint tests; visual timing, wound calculation and end-to-end host integration remain unverified. Knife reach/power/timing are still read/calculated by the existing Rust path pending full native weapon ownership.

### Accelerated condition clock

With native condition ownership enabled, verify timed medicine/boosters, bleeding, radiation and belt artefact effects at normal and accelerated campaign clocks. Introduce a short native reply delay and check that elapsed-time debt catches up without skipping condition updates or applying time twice after retry. Native stepping is bounded to one game second per substep and 60 per proposal; custom thirst remains bounded to one real second per proposal. Codec/substep tests pass; actor-level and load measurements remain pending.

### Grass density changes while paused (2026-11-09)

The renderer now joins grass calculation before reset/unload/destruction and
before scheduling another calculation after a skipped render frame. Repeat the
reported options flow: pause a loaded game, increase grass density, apply, and
resume. Also alternate minimum/maximum density, detail radius/height, grass
on/off, then save/load and travel. Expect no worker memory trap, continuing
terrain rendering, and no stale grass after reset. Automated background coverage
uses actual density/vid_restart commands on Zaton; it does not replace checking
the options widgets, prolonged pause, multiplayer and other maps/GPUs. Details:
`misc/web/webgpu/GRASS-RESET-CRASH-2026-11-09.md`.

Local grass-reset fix published and hash-verified on both `localhost:8132` and
`127.0.0.1:8132`, release `d02651c67b48a2d522315fc54cd74056608aa09606dcedaaf17621ce5a03464c`.
Final headless actual-game run confirmed 8 sparse plus 8 dense config/reset loads,
at least 30 frames after each, and visible gameplay after final settlement, with
no captured runtime exceptions or GPU validation errors. Reload local preview
for options-widget manual retesting; production remains unchanged.

Real-host automated evidence: native_condition_probe passed on a headless Zaton actor with empty equipment. A12.25-game-second batch equals thirteen sequential updates byte for byte; restoring the initial checkpoint is exact. Evidence: ../mechanics-test/native-condition-live-f3w2wrhw/attempt-y0bc2tpx/probe.log. This does not cover wounds/equipment/medicine, live PvP, load or graceful native shutdown; host cleanup required SIGKILL after eight seconds.

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


### Startup overlay save import (2026-11-09; manual game-load check pending)

- [ ] Download Saves from a browser containing a known playable single-player save. Keep this backup outside the browser.
- [ ] On a disposable browser profile/origin, choose Import Saves, select the backup, then Return to Game. Verify Load game lists the imported save and actually resumes it.
- [ ] Import the same backup again: existing save/thumbnail pairs must be reported as kept, with no duplicate entries or changes to their bytes. Unrelated saves must remain intact.
- [ ] Import a malformed JSON backup or one containing an invalid path/checksum/header: no saves should change; a readable error should appear and retry should work.
- [ ] Keep another game tab running for the same origin, then try importing: it must request that the other game tab be closed. Retry after closing it.
- [ ] Verify the import screen does not start the engine or download the game pack, and Return to Game restores normal startup/install behavior.

Automated coverage: eight Node storage/import tests pass, including export/import round trips, case-insensitive pair conflicts, full-input validation, failed-write rollback, interrupted-import recovery and save-directory locks. Isolated headless Chrome verified real OPFS import/export bytes, conflict preservation, rejection while a game lock is held, invalid-input no-write behavior, and no engine/pack requests from the import screen. Evidence: `../mechanics-test/save-import-final-20261109/result.json` and `overlay.png`.

Not yet validated: loading an actual imported compressed save through the running game. The automated fixture only proves file transport and header validation. Old backups lack checksums; header validation does not fully decompress/validate game content. Import preserves existing conflicting saves rather than offering overwrite, and imported timestamps reflect the restore because the backup format contains no original per-file modification times. No deployment/publication was performed for this change.

### Real native radiation route verified; camera scheduling defect fixed (2026-11-09)

Zone-state diagnostics showed the authored volume was online, enabled, radius15 and maxPower0.02 while the collidable living mirror stood inside it. The failure was stock fast/slow zone scheduling based solely on Device.vCameraPosition: the headless director camera remained hundreds of metres from the actual player. Slow scheduled updates could skip the radiation zone's short blowout window. Native A-Life hosts now choose fast zone updates from authoritative player interests within the same radius+50m threshold. Non-host/single-player behavior still uses the original camera rule.

Optimized native build passed (`/tmp/zone-native-zone-interest-build.log`). Repeating the exact same isolated authored-volume test now receives five native radiation hits and confirms their native condition result increases radiation. All earlier stepping/medkit/replay/SQLite checks pass in that run. Evidence: `../mechanics-test/native-condition-zone-interest-20261109/probe.log` and `result.json` (probe exit0). This verifies actual CustomZone→actor→acknowledged socket→native condition routing for one radiation volume, not every anomaly family or all five maps. Cleanup remains forced; graceful shutdown is unverified.

Manual coverage still needed after activation: simultaneous distant players, entry/exit/crouch at hazard boundaries, electric/thermal/chemical/gravity anomalies, safe-zone policy, death/reconnect/travel and dense-scene performance. Native producer saturation, coordinated condition ownership transition and full native weapon/projectile ownership remain open; automatic bootstrap remains disabled.

### Native hit overload acceptance — pending implementation

Developer harness prerequisite before native-condition activation: hold Rust hit acceptance while the native host produces more than 512 eligible hits. Verify bounded native and engine-event memory, no silently retired hits, private acknowledgement/condition traffic remains responsive, and recovery applies each still-valid hit exactly once in order. Repeat with receiver socket removal/rebind and with actor death/respawn or host epoch change during the stall. Verify simulation time does not jump forward into a burst of accumulated anomaly damage on recovery. Ordinary single-player pause/resume must remain unchanged. Existing retransmit tests do **not** cover producer saturation; this check is currently unimplemented, not passed.

Native control refactor regression (2026-11-09): PASS in isolated `native-condition-control-mailbox-20261109` for stepping, medicine/impact replay, SQLite result durability and authored Zaton radiation. Does not cover pause/saturation. New pre-dispatch hit-capacity check is awaiting build/runtime validation; verify that >512 queued hits survive backpressure and that blocked damage does not indefinitely prevent actor lifecycle processing. Graceful native shutdown remains unverified.

Native hit saturation integration (2026-11-09): PASS, evidence `../mechanics-test/native-condition-backpressure-20261109`. Real radiation fills512-hit queue with acknowledgements withheld; condition RPC succeeds while paused;513hits accepted during recovery; host resumes and five further radiation hits apply; zero overflow reports. This does not close multi-player burst, prolonged memory/backlog, socket removal, lifecycle/travel or process-crash cases. Graceful shutdown still unverified. Keep those cases pending rather than marking the whole overload checklist complete.

Sustained native saturation: PASS in `native-condition-backpressure-hold-20261109`: simulation diagnostic unchanged for5seconds while snapshots continue, condition RPC works,512hits recovered, six subsequent radiation hits applied, zero overflow reports. Does not replace multi-player/lifecycle/memory tests. Native weapon callback owner fix awaits build and multi-actor execution validation.

Native weapon ownership pending checks: two separate mirrored actors must receive only their own no-ammo/magazine-empty callbacks; enabling the director unlimited-ammo flag must not allow either network actor to reload/fire without persisted reserve rounds. Owner-callback build passed; finite-ammo guard build/runtime validation pending. These are prerequisites, not completed native weapon authority.

Native reserve-ammo mirror pending: compare persisted box IDs/revisions/types/counts with native owner inventory; repeat identical snapshots after native consumption and ensure no refill; apply newer revision, remove box, switch weapon, holster, respawn and travel. Verify stock capacity rejection and no orphan/dropped-world boxes. Mirror implementation awaits build/runtime checks and does not enable native reload authority.

Reserve-ammo integration PASS: `native-reserve-ammo-20261109` verifies two real owned stock ammo boxes, correct rounds, stable native IDs across a count/revision change, targeted removal and holster cleanup. Native reload/consumption, tombstones after consumption, multiple owners, travel and persistence of native deltas remain pending.

Stock native reload execution PASS: `native-reload-action-20261109` invokes original Action and waits for stock animation completion; AK-74 loads23FMJ, keeps17AP, returns idle/not pending and does not refill for5seconds of repeated snapshots. SQLite ammo intentionally stays unchanged. This is not production reload authority or persisted consumption. Depleted box remained present at0, so destroyed-box tombstone verification is still pending.

### Native weapon action ingress (2026-11-09, development only)

- Automated standalone coverage: exact wire validation, replay fences, retained
  completion until commit, abort tombstones, bounded/coalesced duplicate requests.
- Pending integration: reload request through private host socket, complete native
  magazine/reserve result, durable Rust transaction, lost-response retry, abort
  restoration and player death/travel during reload. These are **not passed** by
  codec or queue checks. Production reload routing remains unchanged.

### Native weapon result transport (2026-11-09)

- Passed: C++ encoder fixture decoded by Rust with exact mixed cartridge order,
  launcher rounds, weapon condition/mode/jam and persisted/new ammo-box identity.
- Passed: malformed/truncated/trailing payload rejection, finite condition checks,
  duplicate box rejection in native encoding, bounds and status-only replies.
- Native capture helper compiles against optimized native configuration. Actual
  reload-result capture, native-created box ownership/lifetime, abort cleanup and
  atomic SQLite commit remain unverified and are not enabled in production.

### Native reload persistence (2026-11-09)

Passed `native_reload_commits_box_graph_atomically_and_replays_after_restart`:
- Magazine and reserve updates plus new native box assignment commit together.
- Per-section round conservation rejects minted/lost ammo; missing box identities
  and stale inventory generations are rejected.
- Injected failure on the final weapon write rolls back earlier ammo changes.
- Exact retries (including persistence-worker restart) return the stored result;
  changed payload under the same native action sequence is rejected.

Still pending: actual native socket→coordinator→SQLite→native commit handshake,
loss/reconnect/life/travel scenarios, and all weapon families. Production action
routing remains on the existing path until that integration is complete.
