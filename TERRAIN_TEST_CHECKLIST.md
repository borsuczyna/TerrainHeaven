# Terrain remesher — manual verification

The automated suite is defined in `src/terrain/TerrainMesher.test.ts`. Per project instructions, run the checks below manually in the browser.

## Basic topology

- Create a terrain with no roads or cut points. Its wireframe should contain only two triangles.
- Change `Mesh Detail`; a completely flat, unconstrained terrain should remain minimal.
- Toggle `Terrain Smoothing`; geometry must remain valid without flashes, holes, or overlapping faces.

## Roads and sidewalks

- Place straight and curved roads through the terrain, with and without sidewalks.
- Verify the terrain hole follows both sides and both open ends exactly.
- Inspect the outer sidewalk seam from a low camera angle. No background-colored strip may be visible between any sidewalk edge and the terrain.
- Move and reshape a road repeatedly in X/Z. An old cutout must never remain after the road footprint changes.
- Join a sidewalk road to a road without a sidewalk; the terrain boundary must follow the tapered sidewalk.
- Connect roads through an intersection and inspect the complete boundary in wireframe mode.
- Move a road above and below the terrain. The transition must widen as needed to respect `Max Slope`.
- Repeat with a large road/terrain height difference; the first terrain band must stay attached to the sidewalk instead of forming a vertical crack.
- Enable bridge mode. A bridge must not cut a terrain hole.

## Terrain cut points

- Add one cut point and move it vertically. The point itself must remain exact while the surrounding terrain changes smoothly.
- Move only the cut point Y repeatedly; interaction should remain responsive and the XZ wireframe topology should not change.
- Place cut points close to a road, on an existing triangle edge, near the terrain boundary, and close to each other.
- Place a cut point inside a road hole; it must not affect that terrain.

## Quality and limits

- Test `Mesh Detail` at `0.5`, `2`, and `5`.
- Test `Triangle Limit` at `100`, `1500`, and `5000`; increasing it may improve local quality but must not create a global grid.
- Inspect wireframe for zero-area slivers, crossed edges, duplicate faces, spikes, and inverted triangles.
- Save and load the project. New settings must persist.
- Load a legacy project using `terrainGridEnabled` and `terrainGridSize`; `terrainGridSize` should become the initial `Mesh Detail`.
