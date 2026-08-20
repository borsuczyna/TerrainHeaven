import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RiverSpline from './RiverSpline';
import TerrainMesher from '../terrain/TerrainMesher';

const expectFiniteGeometry = (river: RiverSpline): void => {
    const positions = river.mesh.geometry.getAttribute('position');
    expect(positions.count).toBeGreaterThan(0);
    for (let index = 0; index < positions.count; index++) {
        expect(Number.isFinite(positions.getX(index))).toBe(true);
        expect(Number.isFinite(positions.getY(index))).toBe(true);
        expect(Number.isFinite(positions.getZ(index))).toBe(true);
    }
};

describe('RiverSpline', () => {
    it('keeps terrain sealed, sculpts the channel and renders a water overlay', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0));
        river.update();

        expect(river.cutsTerrainSurface()).toBe(false);
        const material = (Array.isArray(river.mesh.material) ? river.mesh.material[0] : river.mesh.material) as THREE.MeshStandardMaterial;
        expect(material.transparent).toBe(true);
        expect(material.depthWrite).toBe(false);
        expectFiniteGeometry(river);

        const samples = river.getSampledTerrainPoints();
        expect(samples.length).toBeGreaterThan(6);
        const terrain = new TerrainMesher().build({
            center: new THREE.Vector3(0, 3, 0),
            width: 20,
            length: 20,
            cutAreas: [],
            cutPoints: samples,
            settings: {
                meshDetail: 2,
                triangleLimit: 1200,
                smoothingEnabled: true,
                smoothingRadius: 4,
                maxSlopeDegrees: 35,
            },
        });
        expect(terrain.length).toBeGreaterThan(2);
        const terrainArea = terrain.reduce((sum, triangle) => sum + Math.abs(
            (triangle.b.x - triangle.a.x) * (triangle.c.z - triangle.a.z)
            - (triangle.b.z - triangle.a.z) * (triangle.c.x - triangle.a.x),
        ) * 0.5, 0);
        expect(terrainArea).toBeCloseTo(400, 3);
        expect(terrain.flatMap((triangle) => [triangle.a, triangle.b, triangle.c])
            .some((point) => Math.abs(point.y) < 1e-5)).toBe(true);
    });

    it('keeps both meshes valid when two river paths are connected', () => {
        const first = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0));
        const second = new RiverSpline(new THREE.Vector3(5, 0, 0), new THREE.Vector3(9, 0, 4));
        first.divisions = 4;
        second.divisions = 4;

        expect(second.connect(0, first, 1)).toBe(true);
        expectFiniteGeometry(first);
        expectFiniteGeometry(second);
        expect(first.connections.get(1)?.element).toBe(second);
        expect(second.connections.get(0)?.element).toBe(first);
    });
});
