import { describe, expect, it } from 'vitest';
import { createMeshAsset, MeshStore } from './MeshData';

describe('mesh store: reused-instance export contract', () => {
    it('starts empty and keeps the Unity instance contract for uploaded assets', () => {
        const store = new MeshStore();
        expect(store.assets).toHaveLength(0);
        const assetIndex = store.addAsset(createMeshAsset('Rock', 'rock.obj'));
        store.addInstance(assetIndex, {
            Position: { x: 1, y: 2, z: 3 },
            RotationX: 5,
            RotationY: 123,
            RotationZ: -5,
            Scale: 1.5,
            AssetIndex: assetIndex,
        });
        const data = store.serialize();

        expect(data.Assets.map((asset) => asset.DisplayName)).toEqual(['Rock']);
        expect(data.Assets[0].LibraryPath).toEqual('rock.obj');
        expect(data.Assets[0].BaseScale).toBe(1);
        expect(data.Assets[0].PositionOffset).toEqual({ x: 0, y: 0, z: 0 });
        expect(data.Layers[0].Instances[0]).toEqual({
            Position: { x: 1, y: 2, z: 3 },
            RotationX: 5,
            RotationY: 123,
            RotationZ: -5,
            Scale: 1.5,
            AssetIndex: 0,
        });
    });

    it('round-trips layers and erases in a spherical brush', () => {
        const store = new MeshStore([createMeshAsset('Crate', 'crate.glb')]);
        store.addInstance(0, { Position: { x: 0, y: 0, z: 0 }, RotationX: 0, RotationY: 0, RotationZ: 0, Scale: 1, AssetIndex: 0 });
        store.addInstance(0, { Position: { x: 4, y: 0, z: 0 }, RotationX: 0, RotationY: 0, RotationZ: 0, Scale: 1, AssetIndex: 0 });

        const restored = new MeshStore();
        restored.load(store.serialize());
        expect(restored.isTooClose(0, { x: 0.1, y: 0, z: 0 }, 0.3)).toBe(true);
        expect(restored.removeInstancesNear({ x: 0, y: 0, z: 0 }, 1)).toBe(1);
        expect(restored.getInstances(0)).toHaveLength(1);
    });

    it('renames and removes assets while keeping asset indices valid', () => {
        const store = new MeshStore();
        store.addAsset(createMeshAsset('Tree', 'tree.fbx'));
        const crateIndex = store.addAsset(createMeshAsset('Crate', 'crate.glb'));
        store.renameAsset(crateIndex, 'Wooden Crate');
        store.addInstance(crateIndex, { Position: { x: 0, y: 0, z: 0 }, RotationX: 0, RotationY: 0, RotationZ: 0, Scale: 1, AssetIndex: crateIndex });

        expect(store.removeAsset(0)).toBe(true);
        expect(store.assets.map((asset) => asset.DisplayName)).toEqual(['Wooden Crate']);
        expect(store.getInstances(0)[0].AssetIndex).toBe(0);
    });

    it('calibrates an asset scale and pivot offset, and round-trips them through save/load', () => {
        const store = new MeshStore([createMeshAsset('Barrel', 'barrel.fbx')]);
        store.updateAsset(0, { BaseScale: 0.01, PositionOffset: { x: 0, y: 1.2, z: 0 } });
        expect(store.assets[0].BaseScale).toBe(0.01);
        expect(store.assets[0].PositionOffset).toEqual({ x: 0, y: 1.2, z: 0 });

        store.updateAsset(0, { BaseScale: -5 });
        expect(store.assets[0].BaseScale).toBe(0.01);

        const restored = new MeshStore();
        restored.load(store.serialize());
        expect(restored.assets[0].BaseScale).toBe(0.01);
        expect(restored.assets[0].PositionOffset).toEqual({ x: 0, y: 1.2, z: 0 });
    });

    it('backfills calibration defaults when loading an older project file', () => {
        const restored = new MeshStore();
        restored.load({
            Version: 1,
            Assets: [{ Id: 'a', DisplayName: 'Old Prop', LibraryPath: 'old.obj' } as never],
            Layers: [{ Instances: [] }],
        });
        expect(restored.assets[0].BaseScale).toBe(1);
        expect(restored.assets[0].PositionOffset).toEqual({ x: 0, y: 0, z: 0 });
    });
});
