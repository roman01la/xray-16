# Clear Sky browser integration

Updated 2026-11-13. Clear Sky is deployed in the shared three-game startup
selector at https://stalker-online.xyz/. The optimized build starts the opening
scene and reaches Lebedev's dialogue. Asset upload, database setup and live
transport checks are complete. Broader campaign testing remains manual.

## Engine and references

Reuse the shared OpenXRay WASM64/WebGPU engine with `-cs`. Upstream explicitly
supports Clear Sky 1.5.10 and describes it as finishable with minor bugs.
Its installation instructions also provide a Clear Sky compatibility package.
[Supported games](https://github.com/OpenXRay/xray-16),
[installation instructions](https://github.com/OpenXRay/xray-16/wiki/%5BEN%5D-How-to-install-and-play).

IX-Ray 1.6 is the primary comparison implementation for this port. It publishes
Clear Sky player builds with engine and assets, maintains `gamedata_cs`, and has
recent Clear Sky fixes for options, HUD, scripts and quests. It also provides the
SoC reference already used by this project. This is a suitability assessment
based on the maintained source and release coverage. Comparative full-campaign
testing of the community engines has not been performed.
[IX-Ray project](https://github.com/ixray-team/ixray-1.6-stcop),
[changelog](https://github.com/ixray-team/ixray-1.6-stcop/blob/default/.github/CHANGELOG.md).

The existing sibling checkout `../ixray-soc-reference` now includes
`gamedata_cs`. Its pinned revision is
`054d76deda7a91f83b15b2f88c5cea18681bfc82`.

Useful comparison paths are `gamedata_cs/configs/engine_external.ltx`,
`gamedata_cs/scripts`, `src/xrGame/GameTask.cpp`, and the shared UI implementations.
IX-Ray's `Platform = cs` selects game-specific behavior. Its menu script also uses
IX-Ray-only callback and UI APIs. Transfer individual compatibility fixes with
their dependencies checked against our engine.

IX-Ray 1.5 provides a second reference closer to the original Clear Sky engine.
X-Ray Fixes collects vanilla Clear Sky bug fixes, including inventory and combat
corrections. These can help distinguish inherited game behavior from porting bugs.
[IX-Ray 1.5](https://github.com/ixray-team/ixray-1.5-stcs),
[X-Ray Fixes](https://github.com/Hrusteckiy/xray-fixes).

## Local assets and launch

The supplied Trilogy installer stores Clear Sky under `/stalker2/` in its shared
FreeArc archives. Research output lives in `../cs-research`. The original
installer files remain the input. Normalization selects resources and levels,
then patch 08, then patch 10, with the selected audio/text localization applied.
The source manifest records the selected version of each file.

```sh
node misc/web/tools/prepare-cs.mjs ../cs-research ../cs-research/game-ukr-voices eng
node misc/web/tools/pack-streaming.mjs ../cs-research/game-ukr-voices ../cs-research/pack-ukr-voices
node misc/web/tools/stage-cs.mjs bin/wasm64/Release ../cs-research/stage ../cs-research/game-ukr-voices ../cs-research/pack-ukr-voices
node misc/web/serve.mjs ../cs-research/stage 8393
```

The local developer page is `/cs/?stream=/pack/pack.json&autostart=0`.
It stages the shared shaders and engine, selects `-cs`, and stores settings and
saves under `stream-cs`. Installed chunks use `xray-install-cs-v1`.
The public startup picker and publishing configuration still contain CoP and SoC.

The current pack has Ukrainian voices, with English and Ukrainian text. New
profiles detect the browser language. Existing settings and saves keep the
player's selection. `voiceLanguage` in the source manifest records the fixed
spoken language independently of the default text language.

The Ukrainian voice pack contributes 12,707 files and 428,487,744 bytes before
compression. English text contributes 49 files and 1,180,796 bytes. Ukrainian
text contributes 48 files and 1,149,051 bytes. The current normalized pack is
4,259,348,075 bytes. Superseded English-only and dual-voice test packs were
removed after verification.

## Validation checklist

- [x] Load the Swamps in headless Chrome using the optimized shared engine.
- [x] Start the scripted opening and reach Lebedev's dialogue.
- [x] Save with F5, move, and restore the saved position with F9.
- [x] Change FPS selection and verify the saved setting after Apply.
- [x] Change English text to Ukrainian through the language selector.
- [ ] Start a new game and complete the opening doctor/Lebedev sequence.
- [ ] Check the first task, PDA map, minimap, tutorial, and faction-war UI.
- [ ] Check inventory, trading, repairs/upgrades, detectors, and combat.
- [ ] Save, quickload, reload the page, then load the saved game.
- [ ] Travel out of the Swamps and return, checking campaign progression.
- [ ] Check resolution changes, HUD aspect, graphics settings and audio.
- [ ] Add shared startup UX, analytics identity and deployment support when ready.

Keep runtime failures and completed checks below as the local probe progresses.

## Initial probe findings

All 54,005 inventoried Clear Sky entries were extracted and checked against
their recorded sizes. English normalization selects 25,374 assets in 20 archives,
about 4.23 GB before transport compression. Extraction and normalized copies are
local research data outside the repository.

The optimized shared engine reaches `End of synchronization` in `marsh` and
renders the HUD and world in headless Chrome. Storage and save tests pass (26).

The first probe exposed a campaign-start dependency. Retail `ui_movies.xml`
calls `xr_effects.start_marsh_intro` when the intro movie ends. Skipping that movie
left the actor in the starting room without the opening scene. IX-Ray handles
this dependency explicitly in `gamedata_cs/scripts/ixr_marsh_intro.script`.
Our `CGamePersistent::start_game_intro` now invokes the retail callback when
skipping a new Clear Sky game's movie. Loading a save does not take that branch.
The same transition runs when the loading key prompt is disabled. A 90-second
headless run of the corrected build reached the scripted dialogue and recorded
camera movement without an engine exception. Its screenshot and log are in
`/tmp/xray-cs-opening-fixed.png` and `/tmp/xray-cs-opening-fixed.log`.
The rebuilt engine also passed a separate new-game check with
`keypress_on_start 0`, reaching the scripted camera sequence.

The log also reports legacy PDA/scrollbar texture aliases that the shared UI
requests but the stock Clear Sky atlas does not define. Their visual behavior
still needs checking alongside the full opening and faction-war UI.

## Browser menu checks

The basic video menu has the shared FPS selector and display-derived resolution
list, plus windowed/fullscreen selection. Default rendering uses the medium
preset, a display-appropriate size up to 1080p, 60 FPS and VSync. Existing
preferences remain in effect. Both menu aspect layouts hide the renderer,
desktop exit, and network-game entries. The audio output-device row is removed.

Advanced controls use the WebGPU feature set. MSAA alpha testing still depends
on MSAA being enabled. Renderer resets apply resolution, presets, grass density,
shadow quality and settings that formerly requested a process restart.

Repeat these checks after changing menu scripts or the engine build.

- Select two resolutions, Apply, and check both sharpness and window fit.
- Select 30, 60, and Auto FPS, Apply, then reopen the menu and reload the page.
- Toggle window mode and confirm Escape/U behavior after returning to the game.
- Open advanced graphics and check sunlight, shadow quality, sun shafts, SSAO,
  soft water/particles, wet surfaces and volumetric smoke. Enable MSAA before
  selecting an alpha-test mode.
- Finish the first conversation, press F5, move, then press F9. Reopen the page
  and load the same save. Legacy `.sav` files are included in browser backups
  and preserved-language detection, alongside `.scop` files.
- Select each text language, Apply and reload. Voices stay Ukrainian in both.

The corrected Ukrainian-only pack passed a new-game launch through the sound
collection lookup that failed in the intermediate multilingual-voice build.
The missing `agr_base_commander_reward_pda` recording is present at its original
path in the corrected pack.

The save test recorded position `(-177.640, 4.787, -274.560)`, moved the actor
to approximately `(-176.152, 5.397, -274.765)`, then restored the saved position
with F9. The final save/storage, analytics and compatibility suite passed all
51 tests. A separate existing publishing assertion was updated to check the
bundled compatibility gate in `game-ui.mjs`.

### Extreme sunlight shader fix

The Extreme sunlight filter failed GLSL compilation because its blocker search
used loop variables as texture offsets and its visibility masks used integers
as boolean conditions. The shared shader now shifts normalized sampling
coordinates by the corresponding texel distance and explicitly compares mask
bits to zero. The filter size and weighting remain the same.

The regression test reproduces the reported errors with the original shader
and compiles the corrected filter through the browser WASM shader toolchain,
with comparison gathers both enabled and disabled. All 20 compiler, shader-key
and shader-cache checks pass. A local new-game launch with Extreme configured
reached the opening scene without runtime or shader compilation errors. The
background test browser was then closed.

For manual verification, reload the local build, select Extreme sunlight in
advanced graphics, apply it during gameplay and check outdoor shadows. Repeat
after selecting a lower sunlight quality to exercise renderer recreation.

### Sun-shaft draw context

The missing-direct-draw-buffer report led to a mismatch in volumetric sunlight.
Cascaded sunlight prepares its geometry on a cascade-specific command list,
while the sun-shaft pass accessed the immediate command list through `RCache`.
The pass now receives the caller's command list, preserving its vertex/index
buffers, transforms, uniforms and draw state. The legacy sunlight path passes
its immediate command list explicitly.

A regression test compiles and executes the actual C++ sun-shaft function with
separate immediate and cascade contexts. It checks both quad and cuboid
geometry, near/far phases and min/max shadow variants. The optimized browser
engine builds successfully and the local Clear Sky stage includes the fix.
Manual verification remains to leave the base camp with sun shafts enabled,
including the graphics preset and weather used when the crash occurred.

### NPC aiming pose

The next reported stack resolves through `aimers::weapon::compute_bone` and
`Bone_GetAnimPos` to the invalid bone transform assertion. Clear Sky aiming now
reads the evaluated model-local pose, following IX-Ray's `fill_bones` behavior
and its `LL_GetBoneLocalTransform` implementation. This avoids creating temporary
animation channels and recalculating the bone chain during the aiming lookup.
CoP and SoC retain their existing aiming path. The C++ regression test checks
the requested local/global transforms and the other games' path selection.
The reported encounter still needs manual replay after reloading the build.

## Three-game deployment candidate

The shared selector shows Shadow of Chernobyl, Clear Sky and Call of Pripyat.
Clear Sky has its own card, wallpaper, hover/focus transition, mist and reed
effects, and original game icon. The common startup screen supplies progress,
Start, save backup/import, data removal, pointer capture and exit handling.
English and Ukrainian text are selectable. Voices use the Ukrainian pack.

Analytics uses `cs` for Clear Sky across visits, milestones, performance,
playtime, movement and crash reports. Ten original level maps are exported for
the movement viewer. `server/cloudflare/schema-cs.sql` adds the campaign tables
and adds a separate Clear Sky movement table, preserving existing rows. Migration and
cross-campaign isolation have regression coverage.

The local candidate lives in `../cs-research/deployment-candidate` with
`cs-publication`, `assets` and private native symbols. The preview at
`http://127.0.0.1:8394/` serves all three entries. The existing direct Clear Sky
URL at `http://127.0.0.1:8393/cs/?stream=/pack/pack.json` uses the shared startup
screen. Browser transport verification checked all three engine hashes, WASM
compilation, first asset chunk hashes, thread isolation, picker navigation and
the Clear Sky background transition. The test browser was closed afterward.
The final integration suite passes 83 checks, and the Cloudflare Worker dry
run completes successfully.

The current Clear Sky pack has 307 content-addressed chunks totaling
4,261,628,152 decoded bytes. Deployment uses the existing gzip R2 uploader and
compressed CDN redirect. The local preview reads decoded source chunks.
Private symbol files are kept outside the static asset directory.

For subsequent publication, run the existing chunk uploader for
`cs-publication`, apply `schema-cs.sql`, then deploy the Worker with
`--assets ../cs-research/deployment-candidate/assets`. Keep the verified upload
progress file for resumable retries. Publication completed on 2026-11-13. All 307 gzip chunks were uploaded and
checksum-verified, totaling 2,548,000,458 compressed bytes. The additive database
schema was applied successfully. Cloudflare Worker version
`185ec44a-62cd-4969-b625-f4082b00541b` serves the three-game site.

### Manual release checks

- Hover and keyboard-focus each game card. Confirm its background, title and
  favicon, then choose it and confirm the expected game menu.
- On a fresh Clear Sky installation, check full download progress and the
  disabled Start button. Reload and confirm installed chunks are reused.
- Import and export a Clear Sky save. Verify other games' saves stay separate.
- Repeat NPC aiming near the base exit, Extreme sun quality changes and leaving
  the camp with sun shafts enabled. Report any new assertion with its full log.
- Check an outdoor and indoor scene, window resize, fullscreen/windowed mode,
  30/60/Auto FPS, and medium/high/max graphics.
- Complete a mission, save, reload and change levels. Confirm Ukrainian voices
  with either text language and check PDA, inventory and minimap behavior.
- After deployment, confirm the Clear Sky analytics filter, movement map and
  Sentry game tag using a controlled test session.

### Artwork provenance

The built-in image generator produced `server/web/startup-wallpaper-cs.webp`.
`server/web/game-card-cs.webp` is a smaller version of the same image. The prompt
was “Use case: stylized-concept. Create a photorealistic cinematic 16:9 landscape
wallpaper for a S.T.A.L.K.E.R. Clear Sky browser game startup screen. The Great
Swamps in the Ukrainian Chornobyl exclusion zone, weathered timber boardwalk
crossing shallow marsh water towards a small abandoned fishing hamlet of wooden
shacks with rusting corrugated roofs, a distant skeletal watchtower, cattails and
reeds framing the lower sides, low morning mist over the water, heavy blue-gray
clouds with restrained pale sunlight. Believable real Eastern European wetland,
detailed worn wood and rust, muted olive green and slate blue palette,
atmospheric depth, subtle ominous mood. Wide natural composition with open
central midground so a game selection interface can overlay it. Match polished
photographic game-environment concept art, no people, no logos, no text, no
borders, no UI.”

Live verification passed for all three engine hashes and WASM compilation,
gzip CDN chunks, browser thread isolation and game selection. The three
authenticated analytics pages returned HTTP 200 and the Clear Sky map manifest
contains 10 levels. Gameplay encounter checks above remain for manual testing.
