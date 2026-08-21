import { describe, expect, it } from 'vitest';
import { calibrateGroups, computeGroundedCenterOffset, measureBounds } from './MeshCalibration';
import type { LoadedMeshGroup } from './MeshLoader';

const group = (positions: number[]): LoadedMeshGroup => ({
    name: 'g',
    positions,
    uvs: positions.map(() => 0),
    color: { r: 1, g: 1, b: 1 },
    textureUrl: null,
    texture: null,
});

describe('mesh calibration', () => {
    it('measures the raw bounding box of a group', () => {
        const bounds = measureBounds([group([-1, 0, -2, 1, 4, 2])]);
        expect(bounds).toEqual({
            min: { x: -1, y: 0, z: -2 },
            max: { x: 1, y: 4, z: 2 },
            width: 2,
            height: 4,
            depth: 4,
        });
    });

    it('computes the offset that centers a mesh on X/Z and rests it on Y=0', () => {
        const bounds = measureBounds([group([-1, 2, -3, 3, 6, 5])]);
        expect(computeGroundedCenterOffset(bounds, 1)).toEqual({ x: -1, y: -2, z: -1 });
        expect(computeGroundedCenterOffset(bounds, 2)).toEqual({ x: -2, y: -4, z: -2 });
    });

    it('scales first, then offsets, matching how a user nudges a mis-pivoted upload onto the ground', () => {
        const [calibrated] = calibrateGroups([group([0, 0, 0, 100, 200, 0])], 0.01, { x: 0, y: 1, z: 0 });
        expect(calibrated.positions).toEqual([0, 1, 0, 1, 3, 0]);
    });

    it('falls back to a scale of 1 for a non-positive BaseScale rather than collapsing the mesh', () => {
        const [calibrated] = calibrateGroups([group([2, 3, 4])], -5, { x: 0, y: 0, z: 0 });
        expect(calibrated.positions).toEqual([2, 3, 4]);
    });
});
