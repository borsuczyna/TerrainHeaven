import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Stairs from './Stairs';

describe('Stairs', () => {
    it('builds a closed stepped prism with the authored rise and width', () => {
        const stairs = new Stairs(new THREE.Vector3(0, 1, 0), new THREE.Vector3(8, 5, 0));
        stairs.width = 4;
        stairs.stepCount = 8;
        stairs.railingSide = 'none';

        const groups = stairs.getExportGeometry(0);
        const steps = groups.find((group) => group.name === 'steps')!.triangles;
        expect(steps).toHaveLength(8 * 8 + 4);
        expect(Math.max(...steps.flatMap((triangle) => [triangle.a.y, triangle.b.y, triangle.c.y]))).toBeCloseTo(5);
        expect(Math.max(...steps.flatMap((triangle) => [triangle.a.z, triangle.b.z, triangle.c.z]))).toBeCloseTo(2);
        expect(Math.min(...steps.flatMap((triangle) => [triangle.a.z, triangle.b.z, triangle.c.z]))).toBeCloseTo(-2);
    });

    it('adds configurable railings and reduces geometry at distant LODs', () => {
        const stairs = new Stairs(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 4, 0));
        stairs.stepCount = 24;
        stairs.railingSide = 'both';
        stairs.railingPostSpacing = 1;
        stairs.midRail = true;

        const lod0 = stairs.getExportGeometry(0);
        const lod3 = stairs.getExportGeometry(3);
        expect(lod0.find((group) => group.name === 'railings')!.triangles.length).toBeGreaterThan(0);
        expect(lod3.flatMap((group) => group.triangles).length).toBeLessThan(
            lod0.flatMap((group) => group.triangles).length,
        );
    });

    it('round-trips stair, railing, terrain-cut and UV settings', () => {
        const stairs = new Stairs(new THREE.Vector3(1, 2, 3), new THREE.Vector3(9, 7, 5));
        stairs.width = 5;
        stairs.stepCount = 17;
        stairs.foundationDepth = 0.4;
        stairs.railingSide = 'left';
        stairs.railingHeight = 1.3;
        stairs.railingThickness = 0.12;
        stairs.railingPostSpacing = 2.2;
        stairs.midRail = false;
        stairs.cutTerrain = false;
        stairs.setUVTransform('steps', { offsetX: 0.2, offsetY: 0.3, scaleX: 2, scaleY: 3 });

        const restored = Stairs.deserialize(stairs.serialize(6));
        expect(restored.width).toBeCloseTo(5);
        expect(restored.stepCount).toBe(17);
        expect(restored.foundationDepth).toBeCloseTo(0.4);
        expect(restored.railingSide).toBe('left');
        expect(restored.railingHeight).toBeCloseTo(1.3);
        expect(restored.railingThickness).toBeCloseTo(0.12);
        expect(restored.railingPostSpacing).toBeCloseTo(2.2);
        expect(restored.midRail).toBe(false);
        expect(restored.cutTerrain).toBe(false);
        expect(restored.getUVTransform('steps')).toEqual({ offsetX: 0.2, offsetY: 0.3, scaleX: 2, scaleY: 3 });
        expect(restored.serialize(6).nodes).toEqual([{ x: 1, y: 2, z: 3 }, { x: 9, y: 7, z: 5 }]);
    });

    it('uses one ramp-shaped footprint to cut terrain under the staircase', () => {
        const stairs = new Stairs(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6, 3, 0));
        stairs.width = 2;
        const occupied = stairs.getOccupiedArea();
        expect(occupied).toHaveLength(2);
        expect(new Set(occupied.flatMap((triangle) => [triangle.a.y, triangle.b.y, triangle.c.y]))).toEqual(new Set([0, 3]));
        expect(occupied.every((triangle) => triangle.bankSlopeDegrees === 70)).toBe(true);
    });
});
