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
supports DXT1, DXT3 and DXT5 DDS files. Click a mesh part to isolate and frame it.
The SoC catalog opens on Professor Sakharov when his model is present.
The **List** view loads more results as you scroll. Use **Folders** to expand
the original archive hierarchy. Search works in both views.

Search for a clip under **Animations** and select it to play. Pause or scrub
the timeline to inspect a pose. **In place** holds the root's horizontal
position while the clip plays. Clear it to see the authored root motion.
Choose **Bind pose** to return to the unanimated mesh.

Choose **Maps** to browse the levels in the selected game. The viewer reads
`levels/<name>/level` and `level.geom` for the static terrain, structures, and
placed trees. Drag to orbit, Shift-drag to pan, scroll to zoom, or click
**Top** for an overhead view. A URL with `?game=cop&map=zaton` opens that map.
The preview uses simple lighting and loads diffuse textures at their full
archive resolution, with the original mipmaps where supported. If the terrain
base texture is absent, it uses the level's terrain mask at full resolution
with the default X-Ray detail textures. NPCs, gameplay objects, and water
effects require the game.

Standalone OGF files that refer to external level geometry, earlier OGF
versions, and compressed geometry chunks are outside the importer’s scope.

Vertex layouts and LOD handling follow X-Ray's `FMesh.hpp`,
`Animation/Bone.hpp` and `FProgressive.cpp`. The
[Blender X-Ray OGF importer](https://github.com/PavelBlend/blender-xray/tree/develop/io_scene_xray/formats/ogf)
provides a second reference for the original trilogy's vertex format IDs.
Animation decoding follows `Animation/SkeletonMotions.cpp`,
`SkeletonAnimated.cpp` and `AnimationKeyCalculate.h`.
