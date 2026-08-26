# Unity terrain texture paint import

TerrainHeaven exports texture-painted terrain without subdividing geometry or baking a
large atlas. Each terrain object in `manifest.json` may contain a `terrainPaint` block:

```json
{
  "controlMap": "ControlMaps/terrain_0_control.png",
  "resolution": 128,
  "layers": [
    { "texture": "grass.png", "tiling": 8 },
    { "texture": "dirt.png", "tiling": 6 },
    { "texture": "rock.png", "tiling": 10 },
    { "texture": null, "tiling": 8 }
  ]
}
```

The control map is a standard linear RGBA PNG. R/G/B/A are normalized weights for the
four layers and always add up to 1. Its rows are exported bottom-left for Unity UVs, so
an importer must not flip the texture again. Disable sRGB for the control-map importer,
keep bilinear filtering, and enable mip maps. Layer textures remain ordinary sRGB color
textures stored under `Textures/`.

For a custom mesh material, bind the values as `_Control`, `_Layer0`…`_Layer3` and
`_Layer0Tiling`…`_Layer3Tiling`. Sample each layer with the mesh UV multiplied by its
tiling and blend the four RGB samples using the corresponding control-map channels.
This maps directly to a four-layer Shader Graph or URP/HDRP shader and costs one control
sample plus four color samples regardless of brush count.

Suggested importer sequence:

1. Import OBJ/MTL files and create the terrain GameObject as usual.
2. Find the matching manifest object by `name`.
3. If it has `terrainPaint`, import its control PNG as linear data (`sRGBTexture=false`).
4. Resolve each non-null layer filename inside `Textures/`.
5. Create or reuse a terrain material, bind the control map, layers and tiling values,
   then assign it to every terrain LOD renderer.

Control maps are independent of mesh LOD, so all LODs share the same Texture2D and
material. The exported PNG and layer textures can also be shared by Unity's normal asset
deduplication; the importer does not need to create per-vertex weights or duplicate meshes.
