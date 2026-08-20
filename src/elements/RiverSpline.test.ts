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

        const samples = river.getSampledTerrainPoints(0);
        expect(samples.length).toBeGreaterThan(6);
        const bedSamples = samples.filter((sample) => !sample.profileOnly);
        const profileSamples = samples.filter((sample) => sample.profileOnly);
        expect(bedSamples.every((sample) => sample.position.y < -0.3)).toBe(true);
        expect(profileSamples.length).toBeGreaterThan(0);
        expect(profileSamples.some((sample) => Math.abs(sample.position.y) < 1e-5)).toBe(true);
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
            .some((point) => point.y < -0.3)).toBe(true);
    });

    it('uses Bank Slope as the actual bank angle', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0));
        river.bankSlope = 20;
        const shallow = river.getSampledTerrainPoints(0);
        river.bankSlope = 75;
        const steep = river.getSampledTerrainPoints(0);

        expect(shallow[0].position.y).toBeCloseTo(steep[0].position.y, 8);
        expect(shallow[0].radius).toBeGreaterThan(steep[0].radius * 5);
        expect(shallow[0].maxSlopeDegrees).toBe(20);
        expect(steep[0].maxSlopeDegrees).toBe(75);
    });

    it('rounds and refines the bank profile with Slope Smoothing', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0));
        river.bankSlope = 45;
        river.bankSmoothing = 0;
        const linear = river.getSampledTerrainPoints(0);
        river.bankSmoothing = 1;
        const smooth = river.getSampledTerrainPoints(0);

        const linearBed = linear.find((sample) => !sample.profileOnly)!;
        const smoothBed = smooth.find((sample) => !sample.profileOnly)!;
        const smoothProfile = smooth.filter((sample) => sample.profileOnly);
        expect(smoothBed.radius).toBeCloseTo(linearBed.radius * 1.5, 8);
        expect(smoothBed.slopeSmoothing).toBe(1);
        expect(smoothProfile.length).toBeGreaterThan(0);
        expect(new Set(smoothProfile.map((sample) => sample.position.y.toFixed(5))).size).toBeGreaterThan(2);

        const restored = RiverSpline.deserialize(river.serialize(1));
        expect(restored.bankSmoothing).toBe(1);
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
