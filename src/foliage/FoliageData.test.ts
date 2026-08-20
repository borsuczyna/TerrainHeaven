import { describe, expect, it } from 'vitest';
import { createDefaultFoliageType, FoliageStore, resolveFoliageDimensions } from './FoliageData';

describe('foliage exporter compatibility', () => {
    it('starts empty and keeps the Unity instance contract for user presets', () => {
        const store = new FoliageStore();
        expect(store.types).toHaveLength(0);
        const typeIndex = store.addType(createDefaultFoliageType('Custom Flowers'));
        store.addInstance(typeIndex, {
            Position: { x: 1, y: 2, z: 3 },
            RotationY: 123,
            ScaleT: 0.25,
            ColorT: 0.75,
            TypeIndex: typeIndex,
        });
        const data = store.serialize();

        expect(data.Types.map((type) => type.DisplayName)).toEqual(['Custom Flowers']);
        expect(data.Layers[0].Instances[0]).toEqual({
            Position: { x: 1, y: 2, z: 3 },
            RotationY: 123,
            ScaleT: 0.25,
            ColorT: 0.75,
            TypeIndex: 0,
        });
    });

    it('round-trips layers and erases in a spherical brush', () => {
        const store = new FoliageStore([createDefaultFoliageType('Grass')]);
        store.addInstance(0, { Position: { x: 0, y: 0, z: 0 }, RotationY: 0, ScaleT: 0, ColorT: 0, TypeIndex: 0 });
        store.addInstance(0, { Position: { x: 4, y: 0, z: 0 }, RotationY: 0, ScaleT: 1, ColorT: 1, TypeIndex: 0 });

        const restored = new FoliageStore();
        restored.load(store.serialize());
        expect(restored.isTooClose(0, { x: 0.1, y: 0, z: 0 }, 0.3)).toBe(true);
        expect(restored.removeInstancesNear({ x: 0, y: 0, z: 0 }, 1)).toBe(1);
        expect(restored.getInstances(0)).toHaveLength(1);
    });

    it('edits, duplicates and removes presets while keeping type indices valid', () => {
        const store = new FoliageStore();
        store.addType(createDefaultFoliageType('Grass'));
        const bushIndex = store.addType(createDefaultFoliageType('Bush'));
        store.updateType(bushIndex, { MaxSize: 3, CastShadows: true });
        store.addInstance(bushIndex, { Position: { x: 0, y: 0, z: 0 }, RotationY: 0, ScaleT: 0, ColorT: 0, TypeIndex: bushIndex });
        expect(store.duplicateType(0)).toBe(2);
        expect(store.removeType(0)).toBe(true);
        expect(store.types.map((type) => type.DisplayName)).toEqual(['Bush', 'Grass Copy']);
        expect(store.types[0].MaxSize).toBe(3);
        expect(store.getInstances(0)[0].TypeIndex).toBe(0);
    });

    it('stores normalized factors and resolves placed size from the current preset', () => {
        const preset = createDefaultFoliageType('Tree');
        preset.MinSize = 2;
        preset.MaxSize = 4;
        preset.LengthFactor = 0.5;
        const store = new FoliageStore([preset]);
        store.addInstance(0, { Position: { x: 0, y: 0, z: 0 }, RotationY: 0, ScaleT: 3.5, ColorT: -2, TypeIndex: 99 });

        const instance = store.getInstances(0)[0];
        expect(instance.ScaleT).toBe(1);
        expect(instance.ColorT).toBe(0);
        expect(instance.TypeIndex).toBe(0);
        expect(resolveFoliageDimensions(store.types[0], instance.ScaleT)).toEqual({ width: 2, height: 4 });

        store.updateType(0, { MinSize: 6, MaxSize: 10, LengthFactor: 0.25 });
        expect(instance.ScaleT).toBe(1);
        expect(resolveFoliageDimensions(store.types[0], instance.ScaleT)).toEqual({ width: 2.5, height: 10 });
    });
});
