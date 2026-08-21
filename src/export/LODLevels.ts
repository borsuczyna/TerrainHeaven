import type { TerrainMesherSettings } from '../terrain/TerrainMesher';

// Shared between the live "LOD Preview" setting in the editor and the actual Unity
// exporter, so what you see in preview is exactly what gets exported - both call these
// same functions rather than keeping two coarsening formulas that could quietly drift
// apart. Index 0 is "as authored" (identical to the element's own live settings);
// indices 1-3 are three fixed, progressively coarser presets. Export's "LOD Levels"
// option (default 3) just decides how many of these, starting from 0, get baked into
// the exported file - it does not change the formulas themselves.
export const MAX_LOD_INDEX = 3;

const DETAIL_MULTIPLIER = [1, 2.5, 6, 16];
const TRIANGLE_LIMIT_MULTIPLIER = [1, 0.35, 0.1, 0.02];
const DIVISIONS_DIVISOR = [1, 2, 5, 12];
const DETAIL_LEVEL_DIVISOR = [1, 1.6, 3, 6];

// Reuses the terrain's own real mesher at a coarser meshDetail/triangleLimit rather than
// a separate decimation pass, so holes, banks and slope limits stay correct at every
// level automatically.
export function applyTerrainLOD(base: TerrainMesherSettings, lodIndex: number): TerrainMesherSettings {
    if (lodIndex <= 0) return base;
    const index = Math.min(lodIndex, MAX_LOD_INDEX);
    return {
        ...base,
        meshDetail: base.meshDetail * DETAIL_MULTIPLIER[index],
        triangleLimit: Math.max(50, Math.round(base.triangleLimit * TRIANGLE_LIMIT_MULTIPLIER[index])),
    };
}

// Roads/river cut-splines only have one density knob (Divisions) - coarsen it directly
// instead of touching an unrelated setting.
export function getDivisionsForLOD(divisions: number, lodIndex: number): number {
    if (lodIndex <= 0) return divisions;
    return Math.max(0, Math.round(divisions / DIVISIONS_DIVISOR[Math.min(lodIndex, MAX_LOD_INDEX)]));
}

// Rivers additionally have Detail Level, which controls both longitudinal and
// cross-section sampling independently of Divisions.
export function getDetailLevelForLOD(detailLevel: number, lodIndex: number): number {
    if (lodIndex <= 0) return detailLevel;
    return Math.max(0.1, detailLevel / DETAIL_LEVEL_DIVISOR[Math.min(lodIndex, MAX_LOD_INDEX)]);
}
