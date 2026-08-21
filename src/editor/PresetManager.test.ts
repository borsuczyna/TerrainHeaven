import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import PresetManager from './PresetManager';
import type TextureLibrary from './TextureLibrary';
import Road from '../elements/Road';
import Fence from '../elements/Fence';

const makeManager = (): PresetManager => new PresetManager({
    loadTexture: vi.fn(async () => null),
} as unknown as TextureLibrary);

describe('PresetManager', () => {
    it('captures and reapplies conditional element properties', () => {
        const manager = makeManager();
        const source = new Road(new THREE.Vector3(0, 0, 0), new THREE.Vector3(8, 0, 0));
        source.width = 7;
        source.edgeType = 'bridge';
        source.bridgeEdgeStyle = 'truss';
        source.bridgeEdgeDistance = 4.5;
        source.bridgeEnabled = true;
        source.bridgePillarShape = 'circular';
        source.bridgePillarSegments = 20;
        const preset = manager.savePreset('Highway bridge', source);

        const target = new Road(new THREE.Vector3(0, 0, 0), new THREE.Vector3(3, 0, 0));
        expect(manager.applyPreset(preset.id, target)).toBe(true);
        expect(target.width).toBe(7);
        expect(target.edgeType).toBe('bridge');
        expect(target.bridgeEdgeStyle).toBe('truss');
        expect(target.bridgeEdgeDistance).toBe(4.5);
        expect(target.bridgeEnabled).toBe(true);
        expect(target.bridgePillarShape).toBe('circular');
        expect(target.bridgePillarSegments).toBe(20);
    });

    it('tracks one toggleable default per element type and rejects mismatched drops', () => {
        const manager = makeManager();
        const source = new Fence(new THREE.Vector3(), new THREE.Vector3(5, 0, 0));
        source.postSpacing = 3.25;
        const preset = manager.savePreset('Sparse fence', source);
        manager.setDefault(preset.id);

        const target = new Fence(new THREE.Vector3(), new THREE.Vector3(9, 0, 0));
        expect(manager.applyDefault(target)).toBe(true);
        expect(target.postSpacing).toBe(3.25);
        expect(manager.applyPreset(preset.id, new Road(new THREE.Vector3(), new THREE.Vector3(2, 0, 0)))).toBe(false);

        manager.setDefault(preset.id);
        expect(manager.applyDefault(new Fence(new THREE.Vector3(), new THREE.Vector3(4, 0, 0)))).toBe(false);
    });
});
