# X-Ray Model Viewer

The viewer indexes OGF meshes from the game's X-Ray archives. A C++ importer
compiled to WebAssembly reads inline geometry, the highest-detail LOD,
texture and shader names, and skeleton and skin weights. The viewer renders
the model with WebGL 2. The importer reads embedded animation clips and resolves
external OMF references through the local archive server.

Build with Node.js and an activated Emscripten SDK. The local server uses a
host C++ compiler and `pkg-config` with LZO2 to read compressed archive entries.
Run from the repository root.

```sh
node misc/web/ogf-viewer/build.mjs
node misc/web/ogf-viewer/serve.mjs --soc /path/to/soc
```

Add `--cs` and `--cop` with the corresponding game directories to make them
selectable. Each directory should contain the prepared game's `resources`
archives and any `levels` and `patches` directories. Use `--dist` to point to a
custom build directory and `--port` to change the loopback port.

Open http://127.0.0.1:8465. Search by mesh name or path, select a result, and
the server reads its OGF and referenced DDS textures on demand. The viewer
supports DXT1, DXT3, DXT5 and uncompressed 24-bit and 32-bit RGB DDS files. Click a mesh part to isolate and frame it.
The SoC catalog opens on Professor Sakharov when his model is present.
The **List** view loads more results as you scroll. Use **Folders** to expand
the original archive hierarchy. Search works in both views.

Search for a clip under **Animations** and select it to play. Pause or scrub
the timeline to inspect a pose. **In place** holds the root's horizontal
position while the clip plays. Clear it to see the authored root motion.
Choose **Bind pose** to return to the unanimated mesh.

Choose **Maps** to browse the levels in the selected game. The viewer reads
`levels/<name>/level` and `level.geom` for the static terrain, structures, and
placed trees. Drag to orbit around the surface at the center of the view.
Middle-drag or Shift-drag to pan, scroll to zoom, or click **Top** for an
overhead view. In **Cutaway**, choose which faces to hide. **Hide back faces**
opens inward-facing rooms such as Lab X8 from above. **Hide front faces**
shows the far side of outward-facing surfaces. A URL with
`?game=cop&map=zaton` opens that map.
The preview uses simple lighting and loads diffuse textures at their full
archive resolution, with the original mipmaps where supported. Each level's
own terrain colour texture takes priority over the shared textures. Terrain layers
use the original shader's mask and tile scale, so close-up surfaces preserve
detail. When the base colour texture is absent, the layer colours supply it. NPCs and scripted gameplay objects require the game.

The **Environment** panel selects an original weather cycle or surge and
scrubs its timeline. **Advance time** plays the selected timeline. **Ambient
sound** enables the archived ambient, rain, and thunder audio. The preview
blends the original sky and cloud textures, applies fog and local environment
modifiers where present, and animates water and tree wind. Water ripples use
the game's normal map and reflect the current sky. When the browser can copy
scene depth, shallow water fades into the banks. Water is visible with
weather preview off. Zoom in for directional sun shadows. **Ground cover** draws the maps' grass, reeds, and
small plants from `level.details` as you zoom in. The viewer uses the original
detail mesh atlas and collision geometry for placement. It expands nearby
detail slots in a worker and draws them as instanced meshes.

The environment uses the viewer's WebGL shaders for lighting, precipitation,
lightning, and reflections. The panel provides manual weather selection and
a continuous preview of the authored timelines.

Choose **Effects** to search and play the original particle effects and groups
from `particles.xr`. This includes campfires, anomaly distortion, and
explosions. Artefact models load their configured attached effects and lights
when present. On a map, use **Focus an effect** to zoom to an authored placement
and **Trigger anomaly** to play its configured blowout. Effects run when the map
is zoomed in. Clear **Show effects** to pause and hide them.

The map preview reads authored placements in `all.spawn`. It does not run
missions, dynamic artefact spawning, or game scripts. Particle output uses
the archived textures, emitter actions, and timing with a preview simulation
and simplified lighting and distortion.

Standalone OGF files that refer to external level geometry, earlier OGF
versions, and compressed geometry chunks are outside the importer’s scope.

Vertex layouts and LOD handling follow X-Ray's `FMesh.hpp`,
`Animation/Bone.hpp` and `FProgressive.cpp`. The
[Blender X-Ray OGF importer](https://github.com/PavelBlend/blender-xray/tree/develop/io_scene_xray/formats/ogf)
provides a second reference for the original trilogy's vertex format IDs.
Animation decoding follows `Animation/SkeletonMotions.cpp`,
`SkeletonAnimated.cpp` and `AnimationKeyCalculate.h`.

## Hosted viewer

The static viewer at **/viewer/** reads the game's published archive chunks on
demand and shares the game's browser chunk cache. It uses the same indexed OGF,
OMF, DDS and level files as the local viewer. No game archives are uploaded
when deploying the viewer.

Build with the Emscripten SDK active. Pass the LZO source directory from the
engine build (the directory containing `minilzo/`). Use the archive directories
and the immutable pack URLs from the live game picker. `--published-assets`
points to a staged game bundle containing descriptors for those pack URLs.

```sh
node misc/web/ogf-viewer/stage-hosted.mjs \
  --published-assets /path/to/staged-game-assets --lzo build/web-release/_deps/lzo-src \
  --soc /path/to/soc --soc-pack /packs/SOC_PACK_HASH/pack.json \
  --cs /path/to/cs --cs-pack /packs/CS_PACK_HASH/pack.json \
  --cop /path/to/cop --cop-pack /packs/COP_PACK_HASH/pack.json
npx wrangler@4.160.0 deploy --config misc/web/ogf-viewer/wrangler.jsonc
```

Staging checks the local archive bytes against the published chunk hashes
before generating file offsets. Rebuild the viewer when its game packs change
and retain the pinned pack descriptors while the viewer references them.
