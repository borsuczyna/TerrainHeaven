# TerrainHeaven project conventions

- The game uses a low-poly visual style. Keep generated geometry deliberately simple.
- Road `divisions` must be between 0 and 4. Use `0` for every straight road segment.
- Use only `1`, `2`, `3`, or `4` divisions when a road genuinely needs curvature.
- Never join three or more roads by overlapping endpoints. Create and use an `intersection` element for three-way and multi-road junctions.
