# Nerf map art

`assets/models/map-art.blend` is the editable Blender 5.2 library. Each named collection exports as one runtime mesh; the animals' fins and tails have separate collections for their existing animation pivots. Coordinates in the authoring script use game Y-up, and the Blender file uses Z-up. The exporter converts back automatically.

Rebuild the library from its deterministic authoring script:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_map_art.py
```

To edit the saved library, open the `.blend`, enable the collection you want in the Outliner, and edit its components. Preserve collection names and object origins. Export those edits without rebuilding:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background assets/models/map-art.blend --python tools/blender/export_map_art.py
```

The exporter writes `map-art.js` and `map-art-manifest.json`. It evaluates modifiers, triangulates, preserves corner normals, and bakes material colors into vertex colors. Runtime assets have no texture requests or GLTF loader dependency. Rebuilding from the authoring script replaces manual edits to the `.blend`.

With `npm start`, open `/tools/art-studio.html` for the asset gallery or `/tools/map-studio.html` for the actual maps. The map studio includes close-up views for the statues and understory.

Integrated work:

- Six Olympus pill-person statues with laurel leaves, pleated robes, feathered wings, shields and distinct weapons. Original pedestal colliders remain.
- Tang, butterflyfish, parrotfish and angelfish, with shader tail flex and existing instanced school movement.
- Three decorative mushroom clusters, exposed roots, and sculpted edges on the playable mushroom caps. Cap collision is regenerated from the displayed mesh.
- Shared whale and shark meshes on Tidebreaker and Sunken Reef, retaining their behavioral state machines and fin pivots.
- Snails and beetles beside foliage in Canopy and Mycelium Grove, plus crabs on Reef. Small movement loops are checked against terrain and play features.
- Ferns, broad leaves, conservatory leaves and kelp. Repeated foliage remains instanced or spatially batched. Kelp has 256 triangles per cluster.

Validation includes export integrity tests, existing gameplay tests, browser previews, collision counts, surface-conflict checks and before/after geometry totals. Narrow viewport checks are desktop rendering checks, not physical-phone GPU benchmarks.
