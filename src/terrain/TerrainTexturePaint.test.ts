import { describe, expect, it } from 'vitest';
import TerrainTexturePaint from './TerrainTexturePaint';

describe('TerrainTexturePaint', () => {
    it('keeps normalized byte weights while painting a layer', () => {
        const map = new TerrainTexturePaint(16);
        expect(map.paint({ u: 0.5, v: 0.5, radiusU: 0.25, radiusV: 0.25, layer: 2, opacity: 0.5, hardness: 0.5, rotation: 0, shape: 'soft-round' })).toBe(true);
        for (let offset = 0; offset < map.data.length; offset += 4) {
            expect(map.data[offset] + map.data[offset + 1] + map.data[offset + 2] + map.data[offset + 3]).toBe(255);
        }
        expect(map.data.some((value, index) => index % 4 === 2 && value > 0)).toBe(true);
    });

    it('round-trips compact RLE data', () => {
        const map = new TerrainTexturePaint(16);
        map.paint({ u: 0.4, v: 0.6, radiusU: 0.2, radiusV: 0.2, layer: 1, opacity: 0.8, hardness: 0.2, rotation: 0.3, shape: 'noise', seed: 7 });
        const restored = TerrainTexturePaint.decodeRle(16, map.encodeRle());
        expect(restored.data).toEqual(map.data);
        expect(map.encodeRle().length).toBeLessThan(map.data.length * 2);
    });
});
