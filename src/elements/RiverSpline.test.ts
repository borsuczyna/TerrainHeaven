import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RiverSpline from './RiverSpline';

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
    it('keeps terrain intact and renders as a water overlay', () => {
        const river = new RiverSpline(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 0, 0));
        river.update();

        expect(river.cutsTerrainSurface()).toBe(false);
        const material = (Array.isArray(river.mesh.material) ? river.mesh.material[0] : river.mesh.material) as THREE.MeshStandardMaterial;
        expect(material.transparent).toBe(true);
        expect(material.depthWrite).toBe(false);
        expectFiniteGeometry(river);
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
