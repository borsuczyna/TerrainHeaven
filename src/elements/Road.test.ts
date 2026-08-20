import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Road from './Road';
import type { GeometryGroup } from './WorldElement';

class TestRoad extends Road {
    public geometryGroups(): GeometryGroup[] {
        return this.getGeometry();
    }
}

describe('Road UV mapping', () => {
    it('keeps the longitudinal UV constant across every curved-road section', () => {
        const road = new TestRoad(new THREE.Vector3(-8, 0, 0), new THREE.Vector3(8, 0, 0));
        road.lanes = 1;
        road.width = 6;
        road.divisions = 12;
        road.setCurvePointA(new THREE.Vector3(-5, 0, 10));
        road.setCurvePointB(new THREE.Vector3(5, 0, 10));

        const triangles = road.geometryGroups().find((group) => group.name === 'road')?.triangles ?? [];
        expect(triangles.length).toBeGreaterThan(4);

        for (let index = 0; index < triangles.length; index += 2) {
            const first = triangles[index];
            const second = triangles[index + 1];
            expect(first.uvA.y).toBeCloseTo(first.uvB.y, 8);
            expect(second.uvA.y).toBeCloseTo(first.uvA.y, 8);
            expect(second.uvB.y).toBeCloseTo(second.uvC.y, 8);
        }
    });
});
