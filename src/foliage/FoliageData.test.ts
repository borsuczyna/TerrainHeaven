import { describe, expect, it } from 'vitest';
import { FoliageStore, SUMMER_HIDEOUT_FOLIAGE_TYPES } from './FoliageData';

describe('Summer Hideout foliage compatibility', () => {
    it('keeps the Unity instance contract and database order', () => {
        const store = new FoliageStore();
        store.addInstance(2, {
            Position: { x: 1, y: 2, z: 3 },
            RotationY: 123,
            ScaleT: 0.25,
            ColorT: 0.75,
            TypeIndex: 2,
        });
        const data = store.serialize();

        expect(data.Types.map((type) => type.DisplayName)).toEqual([
            'Grass Yellow', 'Bush', 'Blue Flowers', 'Wild Daisy',
        ]);
        expect(data.Layers[2].Instances[0]).toEqual({
            Position: { x: 1, y: 2, z: 3 },
            RotationY: 123,
            ScaleT: 0.25,
            ColorT: 0.75,
            TypeIndex: 2,
        });
    });

    it('round-trips layers and erases in a spherical brush', () => {
        const store = new FoliageStore(SUMMER_HIDEOUT_FOLIAGE_TYPES);
        store.addInstance(0, { Position: { x: 0, y: 0, z: 0 }, RotationY: 0, ScaleT: 0, ColorT: 0, TypeIndex: 0 });
        store.addInstance(0, { Position: { x: 4, y: 0, z: 0 }, RotationY: 0, ScaleT: 1, ColorT: 1, TypeIndex: 0 });

        const restored = new FoliageStore();
        restored.load(store.serialize());
        expect(restored.isTooClose(0, { x: 0.1, y: 0, z: 0 }, 0.3)).toBe(true);
        expect(restored.removeInstancesNear({ x: 0, y: 0, z: 0 }, 1)).toBe(1);
        expect(restored.getInstances(0)).toHaveLength(1);
    });
});
