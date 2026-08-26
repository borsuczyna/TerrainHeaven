# TerrainHeaven

A browser-based 3D town/terrain editor built with Three.js and TypeScript. Lay out roads and
intersections, sculpt adaptive terrain around them, and dress the scene with a day/night sky.

## Features

- **Roads & intersections** — bezier-curved road segments with adjustable width, lane count,
  sidewalks/curbs, and connectable endpoints. Roads can become bridges with box or circular
  pillars that follow sloped terrain automatically.
- **Stairs** — draggable low-poly stair runs with editable width, rise, step count, terrain
  cutting, separate step/railing materials and optional one- or two-sided handrails.
- **Adaptive terrain** — a single terrain surface remeshes around roads, cuts, and slopes,
  balancing a triangle budget against configurable smoothing/max-slope settings.
- **Terrain cut point / cut spline tools** — sculpt terrain height at a point or along a
  connectable, bezier curve with a configurable divisions count; each has its own influence
  distance controlling how far the height change blends into the surrounding terrain.
- **River tool** — a Road-like connectable spline (width, divisions, curve handles) that does
  *not* cut a hole in the terrain. It forces the terrain mesh to conform tightly to its path
  and height instead, with bank guide-lines shown in the viewport.
- **UV mapping tool** and a texture browser for assigning and tiling textures per surface.
- **Day/night lighting** with a sky dome, sun/moon, clouds, and soft shadows, toggleable
  between a lightweight mode and an enhanced environment.
- **Undo/redo history**, box/ctrl multi-select, copy/paste of elements and properties, and a
  wireframe view.
- Projects save/load to a single JSON file.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed local URL in a browser.

## Scripts

- `npm run dev` — start the Vite dev server.
- `npm run build` — type-check and produce a production build in `dist/`.
- `npm run preview` — preview the production build locally.
- `npm run test` — run the Vitest test suite.

## Tech stack

TypeScript, [three.js](https://threejs.org/) for rendering, [tsyringe](https://github.com/microsoft/tsyringe)
for dependency injection, [poly2tri](https://github.com/r3mi/poly2tri.js) and
[polygon-clipping](https://github.com/mfogel/polygon-clipping) for terrain triangulation and
boolean cuts, and [Vite](https://vite.dev/) for bundling.
