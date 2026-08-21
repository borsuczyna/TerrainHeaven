import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { container } from 'tsyringe';
import SceneManager from '../editor/SceneManager';
import Terrain from './Terrain';

const freshScene = (): SceneManager => {
    const scene = container.resolve(SceneManager);
    for (const element of [...scene.getElements()]) scene.remove(element);
    return scene;
};

describe('Terrain.smoothHeight', () => {
    it('pulls a sharp spike toward its neighbours instead of leaving it untouched', () => {
        const scene = freshScene();
        const terrain = new Terrain(new THREE.Vector3(0, 0, 0), 20, 20);
        scene.add(terrain);

        // A single spike surrounded by flat ground - offset by 10 at the centre cell,
        // nothing anywhere else.
        terrain.paintHeight(new THREE.Vector3(0, 0, 0), 0.5, 10);
        const before = Terrain.getPaintedHeightOffsetAt([terrain], 0, 0);
        expect(before).toBeCloseTo(10, 3);

        const changed = Terrain.smoothHeight(new THREE.Vector3(0, 0, 0), 2, 1, [terrain]);
        expect(changed).toBe(true);
        const after = Terrain.getPaintedHeightOffsetAt([terrain], 0, 0);

        // Averaged with its (all-zero) 3x3 neighbourhood at full strength: 10/9.
        expect(after).toBeLessThan(before);
        expect(after).toBeCloseTo(10 / 9, 2);
    });

    it('leaves already-flat terrain untouched', () => {
        const scene = freshScene();
        const terrain = new Terrain(new THREE.Vector3(0, 0, 0), 20, 20);
        scene.add(terrain);

        const changed = Terrain.smoothHeight(new THREE.Vector3(0, 0, 0), 3, 1, [terrain]);
        expect(changed).toBe(false);
    });

    it('smooths correctly across a seam between two tiles, reading the neighbour\'s cells too', () => {
        const scene = freshScene();
        const left = new Terrain(new THREE.Vector3(-10, 0, 0), 20, 20);
        const right = new Terrain(new THREE.Vector3(10, 0, 0), 20, 20);
        scene.add(left);
        scene.add(right);

        // Paint a spike exactly on the shared edge (x=0), visible to both tiles.
        for (const terrain of [left, right]) {
            if (terrain.intersectsPaintBrush(new THREE.Vector3(0, 0, 0), 0.5)) {
                terrain.paintHeight(new THREE.Vector3(0, 0, 0), 0.5, 10);
            }
        }

        const allTerrains = [left, right];
        Terrain.smoothHeight(new THREE.Vector3(0, 0, 0), 2, 1, allTerrains);

        const resolved = Terrain.getPaintedHeightOffsetAt(allTerrains, 0, 0);
        expect(resolved).toBeLessThan(10);
        // The shared field must resolve the same value regardless of which tile is
        // listed first - order must not decide whose smoothed value wins on the seam.
        expect(Terrain.getPaintedHeightOffsetAt([right, left], 0, 0)).toBeCloseTo(resolved, 5);
    });
});
