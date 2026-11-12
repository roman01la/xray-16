# Shadow of Chernobyl browser integration

Status (2026-11-12): SoC is playable in the local browser build and integrated
into the shared startup picker. The deployment candidate includes both campaigns.
Production still serves Call of Pripyat.

See [Cloudflare publishing](../../server/cloudflare/README.md#publishing-both-campaigns)
for the release procedure. The earlier entries below record compatibility work and
the manual checks used to validate it.

## Product direction

Add **Shadow of Chernobyl** as a separate game entry on the startup overlay,
alongside **Call of Pripyat**, on the same website. Select a game before its
engine or bulk assets load. Download the selected game's complete data before
enabling Start Game; subsequent launches download only changed content.

Keep each game's saves, settings, install metadata, and release selection
separate. Preserve existing CoP browser saves without moving or renaming them.
Switching games must stop the previous engine/worker or reload the document;
do not run both engines concurrently. Keep release hashes out of the visible URL.

## Reference checkout

- Upstream: https://github.com/ixray-team/ixray-1.6-stcop
- Investigated revision: `054d76deda7a91f83b15b2f88c5cea18681bfc82`.
- Local sibling directory: `../ixray-soc-reference` (sparse checkout, outside
  this repository; not a new production engine dependency).
- IX-Ray ships a SoC build and continues its SoC work in the 1.6 repository.
- Its `build-engine.yml` packages shared engine binaries with per-title resources
  (`variant: cop, cs, soc, coc`); the SoC package uses `patch_soc`. This supports
  investigating one browser engine with distinct title packs, not assuming it works.
- Source inspection found explicit SoC mode in `src/xrCore/EngineExternal.*`,
  `GameTask.cpp`, `script_binder_object_wrapper.cpp`, actor condition/camera
  handling, tutorials, menus, and dog state/animation handling.
- `src/xrGame/ui/UIPdaWnd.cpp` includes legacy quests/map/diary/contacts/ranking/
  statistics/encyclopedia tab handling.
- `gamedata_soc/configs/engine_external.ltx` selects `Platform = soc` and
  configures legacy gameplay. `gamedata_soc/scripts` is part of compatibility.

User-confirmed approach (2026-11-11): reuse our WASM/WebGPU engine and selectively adapt IX-Ray's
SoC compatibility, using existing OpenXRay SoC branches where possible. Do not
copy all IX-Ray gamedata into our engine: its scripts/configs can depend on new
engine APIs and features. Assess each transferred subsystem with its resources.
This remains a hypothesis until a Cordon boot demonstrates compatibility.

A full IX-Ray WASM port is the fallback, not an accomplished build. Its native
renderers, platform setup, CPU flags and scripting dependencies still need a
browser port. Its current platform header has no Emscripten target.

## Supplied asset bundle

Source: `/Users/romanliutikov/Downloads/STALKER_Trilogy`.

`setup_soc.exe` is an Inno Setup 5.3.10 installer. Actual assets are in fourteen
FreeArc `data*.bin` archives, shared by the three titles and grouped by file
type. SoC entries have a `/stalker1/` path component. The inventory found
33,158 SoC file entries totaling 6.67 GiB, including duplicate patch versions
and native binaries. This is NOT the eventual browser download size.

Local research output: `../soc-research/inventory.json`, per-archive listings,
extraction logs, `extraction-verification.json` and `extracted/`. No game assets
belong in Git. All 33,158 SoC entries were extracted from all 14 archives and
checked against inventory sizes; no other title files were extracted. Additionally,
all 4,590 scripts/configuration archive entries passed independent CRC32 checks.

The existing ARM-native unarc reader lists archives, but trapped while extracting
the spawn archive. A separate WASM unarc build successfully extracted the SoC
spawn entries. The scripts archive initially failed in the old optimized PPMd
decoder; recompiling that codec with `-O0 -fno-strict-aliasing` resolved extraction,
and its output passed the archive CRC32 checks. This is an extractor portability
issue, not a demonstrated problem with the supplied game data. The research copy
adds directory-component filtering so other
games are not extracted; the existing extractor is unchanged.

Archive paths preserve `gamedata.db0.unpack` through patch archives such as
`gamedata.dba.unpack` and `gamedata.dbb.unpack`. Do not flatten arbitrarily or
choose by file timestamp. Establish archive precedence, localization and patch
version first. Keep original assets distinct from IX-Ray overrides. The installer
contains several binary patch versions; presence is not proof of the final
installed game version. The extracted localization configurations identify `db0`
as English, `db9` as Russian and `dbu` as Ukrainian. Do not execute supplied
Windows binaries to extract data.

## Existing browser integration gaps

| Area | Current assumption | Required change |
|---|---|---|
| Startup | CoP branding and automatic preparation | Game selector before loading; per-game readiness/progress |
| Asset packer | `resources/levels/localization/patches`, numeric `.db` suffixes | Handle SoC layout/archives or explicitly repack normalized data; verify precedence |
| Launcher | `stream-cop` root | Stable title ID mapped to engine release, pack and explicit game mode |
| Staging | CoP icon, menu/sound patches and engine assets | Per-game staging; retain common renderer/audio/browser support |
| Saves | Backup accepts `.scop` and `.dds`, no title identity | Verify SoC save format; identify title in new backups, reject cross-game imports; retain old CoP backups |
| Settings | Stored beneath selected OPFS game root | Separate SoC root, preserve existing CoP root |
| Storage deletion | Single-title assumptions | Delete selected game's data without removing the other's assets/saves |
| Analytics | Single game | Attach validated game ID; keep existing data attributed to CoP |
| Publication | One current release/pack | Per-game release entries; one website, immutable payloads |

Content-addressed chunks may share physical storage when hashes match. Game
identity is still required for install state and safe cleanup. Decide whether
one engine binary serves both titles only after the compatibility probe; the
overlay should support separate binaries without imposing that requirement.

## First concrete compatibility probes

- Existing engine already accepts `-soc` / `-shoc`; test that path rather than
  introducing a second mode flag. The flag is read in `src/xrEngine/x_ray.cpp`.
- Extracted SoC `game.graph` files have version 8. Compare both graph and level
  cross-table handling against the existing legacy loaders before converting data.
- A specific donor difference: IX-Ray selects `CStateMonsterRest<CAI_Dog>` in
  SoC mode; our dog state manager unconditionally selects `CStateGroupRest`.
  This is a candidate for the known missing dog-animation compatibility, not a
  verified fix. Test SoC dogs after the initial boot before changing shared AI.
- The original assets use `config/` while IX-Ray supplies `configs/`; decide the
  mounted configuration path explicitly, including scripts that refer to it.
- The bundle includes `.dbu` localization and `.dbc`/`.dbd` variants as well as
  `.dba`/`.dbb`; do not assume the lexically last archive is always a patch.
- Backup and Delete Game Data controls have hardcoded `stream-cop` assumptions;
  these must be fixed before exposing a playable second entry.

## Execution checkpoints

- [x] Inspect IX-Ray source and pin reference revision.
- [x] Inventory supplied SoC assets without unpacking other titles.
- [x] Prove selective extraction of SoC spawn data.
- [x] Complete and validate selective extraction (all 14 archives).
- [ ] Resolve patch/localization order.
- [x] Prepare a SoC asset pack and separate local staging directory.
- [x] Probe existing engine in explicit SoC mode; record first concrete blockers.
- [ ] Adapt required IX-Ray compatibility in dependency order: loading/formats,
  scripts, HUD/UI/PDA, actor/weapons, AI/animations, quests and transitions.
- [ ] Reach Cordon and complete Sidorovich's opening interaction.
- [ ] Validate save/load and travel before enabling the SoC startup entry.
- [ ] Implement per-game startup selection, saves, settings, downloads and analytics.
- [ ] Regress CoP; publish SoC only after its playable milestone is established.

## Manual acceptance / unverified work

Nothing below has been claimed as passed for SoC:

1. Fresh browser: choose either title, install only that title, then Start Game.
2. Existing CoP browser: saves/settings remain intact after adding SoC.
3. SoC: intro/new game, Sidorovich dialogue/tutorial, first mission and PDA updates.
4. Movement, inventory, trading, weapon HUD/reload/fire, damage and death.
5. NPC combat/speech and mutant animations, particularly dogs.
6. Quicksave/manual save, reload, export/import; reject a backup for the other game.
7. Cordon-to-Garbage travel and return; subsequent campaign levels and endings.
8. Cold/warm startup, interrupted download, incremental update, per-title deletion.
9. CoP launch/new game/load existing save after every shared-engine change.

Full campaign completion, mod compatibility, existing native-save compatibility
and SoC performance remain unverified. Do not label a successful boot as campaign
support. No SoC deployment or public playable entry exists yet.

## Local boot evidence (2026-11-11)

`prepare-soc.mjs` normalizes explicit archive precedence into 24 X-Ray archives;
`pack-streaming.mjs` creates their content-addressed chunks. `stage-soc.mjs`
stages a separate developer page, original `config/` path, SoC compatibility
settings and shared shaders, excluding CoP gameplay patches. Launcher title
identity comes from `data-game="soc"`; the default remains CoP. OPFS roots are
separate (`stream-soc` versus the existing `stream-cop`).

The first English probe failed in StringTable: the base localization config says
English, but the supplied extraction has no English text XML. Packaging now
rejects a requested language without its text assets. The Ukrainian pack is
5.72 GB logical data. Private background Chrome reached the SoC main menu;
`../soc-research/menu.png` records it with zero WebGPU validation errors.
This is not yet proof of campaign playability.

Original scripts use X-Ray's C-style Lua comments. Stock browser Lua 5.1 rejected
`_g.script`, `ce_switcher.script` and `game_last_sv.script` at `//`. The browser
build now generates a lexer with line/block comment support, preserving division,
quoted/long strings and line numbers. The original dependency source is unchanged.
The focused `tests/lua-xray-comments.lua` check passes against a native interpreter
built from that generated lexer. 435 of 440 supplied `scripts/*.script` files
parse; five legacy files still fail (`copy of _test`, `gulag_selo`, `lua_help`,
`mob_alife_control`, `test_ini`). Their reachability is unverified; do not silently
rewrite or delete them. Original scripts/assets remain unchanged.

Other observed warnings: legacy shader/blender version differences and missing
`music\wasteland2`. These still need fidelity checks. The private harness records
fatal alerts to the console so a blocking browser dialog cannot hide the engine
error. No production runtime/dialog behavior was changed for this diagnostic.

Campaign boot now creates the A-Life simulation, accepts the local player and
loads Cordon collision data. A resource-archive lookup incorrectly read map-only
header fields from every resource archive; `GetArchiveHeader` now ignores
headers without map identity. The next observed failure was the missing `main`
node in original `maingame_16.xml`. IX-Ray's flat-root HUD handling is being
adapted, including absent CoP-only hazard/fire-mode widgets and the legacy disk
activity indicator. This is an active compatibility step, not completed HUD QA.

The missing menu music is specifically a stereo-format compatibility gap:
SoC supplies `wasteland2_l.ogg` and `wasteland2_r.ogg`, while the browser path
requests the unsuffixed name. Preserve both channels when addressing this;
substituting one mono channel is not a fidelity fix.

The HUD/minimap compatibility work follows the reference implementations in
IX-Ray `src/xrGame/ui/UIMainIngameWnd.cpp`, `UIHudStatesWnd.cpp`, and `UIZoneMap.cpp`.
The original `static_pda_online` widget is initialized from SoC's main HUD XML
and reuses the existing PDA contact updater. Its position is converted into
minimap-background coordinates; screen placement and behavior still require
in-game visual validation. CoP keeps its existing counter subtree.

### Cordon milestone

The rebuilt Release engine now creates a new SoC game and renders Sidorovich's
bunker with the original HUD and contact counter. Evidence:
`../soc-research/cordon.png`, `new-game-console.log`, and `boot-events.jsonl`.
The screenshot reports 60 FPS and zero WebGPU validation errors in this indoor
view; this is not an outdoor performance benchmark. No fatal engine error was
observed during the initial running interval.

The opening dialogue is NOT verified: automated input has not yet opened it.
The private headless harness briefly targeted Chrome's own Help tab; it now
selects the SoC URL explicitly. Separate that automation issue from actual game
input/intro behavior when continuing the interaction probe. No input bypass was
added to production code.

Remaining observed fidelity gaps include missing SoC dog motions (group-rest
versus legacy-rest behavior), stereo menu music, missing renderer helper textures
and UI scrollbar texture names. The legacy HUD changes compile successfully;
27 browser storage/save/streaming regression tests pass. CoP gameplay regression,
SoC dialogue/movement/inventory/save/load/travel, and public startup selection
remain outstanding. Nothing has been committed or deployed in this exploration.

## Manual-flow test results (background Chrome, 2026-11-11)

The private CDP harness now uses `rawKeyDown`/`keyUp` with ordinary game key
bindings, holds keys across frames and keeps its connection/focus active during
input. No production input handling was modified or bypassed.

| Check | Result | Evidence / limitation |
|---|---|---|
| New game into Cordon | PASS | Sidorovich's bunker rendered; original HUD visible |
| Keyboard movement and view | PASS | Walked toward trader; arrow-key view rotation changed camera |
| Inventory open/close | PASS | Original SoC inventory and actor information rendered (`test-inventory.png`) |
| Trader interaction | PASS | F opens Ukrainian dialogue (`test-trader-dialogue.png`) |
| Opening quest choices | PASS | Selected experienced-player path, advanced conversation, received “Talk to Wolf” (`test-dialogue-continue2.png`) |
| Quicksave | PASS for write | F6 wrote `player - quicksave.sav`; engine reports 17,438 objects saved |
| Quickload | FAIL | F7 reads save/object registry, then crashes in `task_manager.script:222` |
| GPU validation | PASS in this run | Zero reported errors through indoor movement/dialogue/inventory |
| Performance | Limited observation | Approximately 60 FPS in bunker; no outdoor benchmark |
| Outdoor play, combat, level travel | NOT TESTED | Save/load blocker remains |
| Sound fidelity | NOT VERIFIED | Stereo asset compatibility remains outstanding |
| CoP gameplay regression | NOT TESTED | Public CoP deployment unchanged |

Quickload diagnostic: `selected_target` reads as unsigned `4294967295` while the
original script checks `selected_target ~= -1`. It consequently attempts
`alife():object(4294967295)` (invalid object ID 65535), then dereferences nil in
a `defend_lager` task. This is an unset-target/sentinel compatibility problem,
not evidence that all saved world objects disappeared. Inspect serialization
and the script's default-task handling before fixing; IX-Ray's corresponding
script guards a missing object by falling back to the actor. Do not silently
substitute a real task target without verifying its semantics. Log:
`../soc-research/boot-state.json` and `test-console.log`.

Additional warnings: absent `ui_talk_show`/`ui_talk_hide` info portions, legacy
inventory slot-count differences, missing optional actor hit-sound type,
missing dog animations and several helper/UI textures. Opening quest assignment
works despite these warnings, but they remain fidelity tasks.

### Quicksave reload fix verified (2026-11-11)

The quickload failure above is fixed in the local SoC stage. `soc-compat.mjs`
applies a narrowly checked transformation to the supplied task-manager script
while staging; original archives and CoP resources remain unchanged. Both `-1`
and `4294967295` are treated as an unassigned target, clearing stale target
fields. Unassigned defend tasks do not request an A-Life object. Real assigned
IDs still take the original lookup path; no actor substitution or generic
missing-object suppression is introduced.

Validation:
- `tests/soc-task-load.lua` executes the staged load function against signed and
  unsigned sentinels, stale preexisting fields, a real defend target and a real
  non-defend target. All pass.
- The exact previously failing `player - quicksave.sav` loads at browser startup.
- Pressing F7 again in the running game reloads that save successfully.
- Inventory opens after reloading, original location/inventory are restored,
  and the capture reports zero WebGPU validation errors.
- Evidence: `../soc-research/load-fixed-console.log` and
  `quickload-fixed-inventory.png`. No deployment performed.

Stage command now requires the normalized source folder so compatibility scripts
can be generated without embedding original game data in Git:

```
node misc/web/tools/stage-soc.mjs bin/wasm64/Release ../soc-research/stage ../soc-research/normalized-ukr ../soc-research/pack-ukr
```

### Village crash and PDA tutorial patch (manual verification requested)

The user's exact WASM offsets decode to `CKinematicsAnimated::ID_Cycle`,
`PlayCycle`, and `CStateCustomGroup<CAI_Dog>::execute`. SoC dog rest now selects
`CStateMonsterRest`, matching IX-Ray; CoP retains its group-rest implementation.
This addresses the identified missing group-idle animation call, not every
remaining dog-animation warning. The Release build succeeds and is staged
locally. The reported village route still needs manual retesting.

Tutorial handling now recognizes SoC `pda_quests` from the very first 18-second
item, plus legacy contacts/diary/encyclopedia section commands and the legacy
ranking tab ID. Previously only later commands such as `pda_map` were understood.
Full legacy PDA panel content remains a separate compatibility gap: this engine
has incomplete diary/contacts/encyclopedia/ranking support and a different task
panel implementation. Opening the shell at the correct time is not proof that
all tutorial panels function. The user will manually retest the walkthrough.

Fatal dialogs now append stack details instead of overwriting the original
assertion description. Subsequent reports should retain the actual failure
message rather than only “stack trace”. No public deployment was performed.

### Options dialog and incomplete PDA follow-up

User manual testing confirmed that the PDA now opens but its contents do not
follow the tutorial. Source inspection explains why: `known_soc_tab_ids` labels
legacy tabs, but `CUIPdaWnd` only constructs newer task/map/faction/actor-info/
ranking/log windows. There are no native SoC events, diary, contacts, encyclopedia
or stalker-ranking panels wired in. `SetActiveSubdialog` can retain the previous
panel when the requested panel does not exist. The tutorial-name mapping alone
is insufficient; this remains NOT FIXED.

IX-Ray donor components to adapt (not merely copy aliases): `UIEventsWnd` plus
legacy task-item/description dependencies, `UIDiaryWnd2`, `UIPdaContactsWnd`,
`UIEncyclopediaWnd`/`UIEncyclopediaArticleWnd`, `UIStalkersRankingWnd`, and their
construction/ownership/update wiring in `UIPdaWnd`. Preserve original SoC XML,
quest state and article data; do not replace missing panels with unrelated CoP
panels. Adapt donor APIs to current X-Ray UI classes and exclude IX-Ray-only
navigation/gamepad helpers unless necessary. Each panel needs its own manual
acceptance check, including switching during the walkthrough.

The options crash is separately patched: `CScriptXmlInit::InitTab` now passes
`ShadowOfChernobylMode` as `defaultIdsAllowed`, matching the existing legacy-PDA
initialization policy. SoC gets zero-based IDs for XML buttons that omit IDs;
CoP keeps strict validation. Release build and whitespace check pass; refreshed
local stage at port 8391. Gameplay verification left to the user as requested.

### PDA marker positions

Cordon and Yantar ship an old `[level_map]` section with `x1`/`x2`/`z1`/`z2`
keys. Selecting it made the port use its generic 20 km bounds and cluster
markers near the center. SoC now uses the artwork and matching `bound_rect`
from `game_maps_single.ltx` when the level lacks a modern map definition.
Both pairs were checked against the packed assets. Manual check: reload the
same Cordon save, compare the actor marker to the horizontal road, then cross
the road and confirm the marker crosses it in the same direction.

The reported PDA `null function` trap resolved to
`CUIMapLocationHint::SetInfoTask` from `CMapSpot::Update`. The original SoC
tooltip has no task icon or time widgets, so quest markers now use its text
field. Manual check: hover an active quest marker until the hint appears,
move away, and hover a second marker. The map should remain responsive.

### PDA mission lifecycle

After reloading a save, SoC now restores the original XML story conditions
and completion/failure actions for each objective. It rebuilds quest markers
from live objectives and removes the old saved copies. Scripted and
player-defined markers retain their own save behavior. Completing one step
removes its marker and moves tracking to an available objective. The PDA's
Active, Completed and Failed filters use the original SoC labels and refresh
when tasks change.

Manual checks for an existing Agroprom save:

- Load after meeting Mole. The old meeting marker should be gone from the
  PDA and minimap, and the next available objective should remain visible.
- Complete or fail a mission. Check its PDA filter, objective text, and map
  markers, then save and reload. Check that unrelated markers survive.
- Click two active markers in turn and check that the selection and pointer
  follow the chosen objective. Hover a marker while it is removed to check
  that its tooltip closes.

### Return travel and video settings

The Garbage-to-Cordon trap reached quest XML lookup during A-Life save
restoration. Clearing an XML document now clears its root pointers, and the
quest loader reloads definitions when needed. Manual check: cross both ways
with an active quest and confirm its state and turn-in still work.

SoC applies resolution, quality preset, and grass density through a renderer
reset on Accept and saves the settings for the next launch. Texture quality is
used when textures load. Supersampling is a legacy control with no effect on
this renderer. Manual check: change resolution and preset in the same visit,
apply, then reopen the menu after a browser reload.

The renderer uses the browser window's aspect ratio at 4:3 and wider. Narrower
windows fit a centered 4:3 view to keep the original HUD and menus proportional.
**Options → Video → Resolution** sets the render size limit. The list includes
16:9 modes alongside the display's own aspect ratio.

New profiles start on the medium graphics preset (`Default`), with the same
display-based resolution selection as CoP, a 60 FPS cap and VSync enabled.

The bridge triangles disappear with `rs_detail off`. The wasm64 grass cache
bridge now passes the native pointer stride so eviction can see the entire
visible slot list. A forced-eviction test checks that a visible slot after
the first pointer remains protected. Manual check: load the bridge save on
the highest preset with grass enabled and repeat the route to Garbage.

The glitches recurred after the pointer stride fix and still cleared with
`rs_detail off`. SoC now uploads visible grass instance data directly while
retaining instanced draws. Repeat the same route with grass enabled to check
whether the glitch survives without the persistent GPU cache. Also check that
the Advanced Video shadow quality slider can be moved and applied.

The loot crash reached `highlight_weapons_for_ammo` on item hover. The open
inventory now removes cells for items that the engine is about to destroy.
Manual check: loot a corpse or stash and hover ammo while items are moved or
removed, including stacks.

### Controller encounter

SoC's Controller config uses `tube_min_dist`. Its psychic attack now reads the
same resolved distance as the Controller AI, which accepts that legacy key.
Manual check: reload a save before the underground encounter and let the
Controller finish a psychic attack.

### Bar and underground combat

- At the Bar, check that dogs can finish their growl and idle animations.
  SoC uses the corresponding cycles supplied with its original dog models.
- In Agroprom Underground, check gunfire against concrete and brick cover.
  The original SoC material rules let bullets pass through bushes and let
  some rounds penetrate thin cover according to ammo and remaining speed.
- Check the main menu and Video options. The browser removes the desktop
  exit and renderer selection, and the in-game menu still lets players
  return to the main menu.

### Browser controls

- From the in-game menu, choose the option to return to the main menu. Cancel
  once to verify the session stays open, then confirm to return to the menu.
- Release mouse capture with Escape in windowed mode or switch tabs. On
  return, the game dims and asks for a click. The capture click should restore
  mouse control without firing a weapon or clicking an in-game menu item.
- In **Options → Video → Advanced**, check that the FPS selector offers Auto,
  30, 60, 100 and 120. Apply a value and reload to check persistence. New
  profiles default to 60 FPS.

### Text languages

Pass the extracted `config/text` directory as the fourth argument to
`prepare-soc.mjs` to add retail text to the Ukrainian base. The private
input combines the original North American retail disc with the official US
1.0005 update. Keep the retail and update archives outside Git. The packer puts
the additional text in `localization/retail_text.db`. For an incremental update
to the existing SoC pack, append that archive and its source manifest entries
to the existing normalized assets before running `pack-streaming.mjs`.

**Options → Game → Language** offers Czech, English, French, German, Italian,
Polish, Russian, Spanish and Ukrainian. On a fresh profile, the browser's
language preference selects the first supported language and falls back to
English. Test a profile with existing saves and one with a saved selection to
verify that startup respects both. Spoken dialogue continues to use the base
pack's audio. In CoP, the nine shipped text catalogs average 1.22 MB each and
the Ukrainian audio and text archive is 166.13 MB.

### Scope overlays and navigation

- Aim with an AK-74 fitted with a PSO-1 and with a Vintorez to check attachable
  and built-in scopes. SoC draws the original DDS overlay from `scope_texture`.
- Retry the tunnel escort using a save from before the reported crash. The
  script navigation bindings now reject invalid level vertex IDs before
  accessing the graph.
