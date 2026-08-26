import { describe, expect, it } from 'vitest';
import { ProjectDocument } from './project.js';
import { createPolishVillage } from './village.js';
import type { ProjectData } from './types.js';

const emptyProject = (): ProjectData => ({ version: 1, settings: {}, elements: [], connections: [] });

describe('ProjectDocument', () => {
    it('creates a connected road path and safely remaps IDs after deletion', () => {
        const document = new ProjectDocument(emptyProject());
        const ids = document.addRoadPath([
            { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 2 },
        ]);
        document.addHouse({ center: { x: 5, y: 0, z: 8 } });

        expect(ids).toEqual([0, 1]);
        expect(document.data.connections).toEqual([{ elementA: 0, nodeA: 1, elementB: 1, nodeB: 0 }]);
        document.deleteElements([0]);
        expect(document.data.elements.map((element) => element.id)).toEqual([0, 1]);
        expect(document.data.connections).toEqual([]);
    });

    it('creates a complete editable house with wall-cut openings', () => {
        const document = new ProjectDocument(emptyProject());
        const id = document.addHouse({ center: { x: 0, y: 0, z: 0 }, roofType: 'hip', windowsPerSide: 2, wing: true });
        const house = document.get(id);

        expect(house.type).toBe('building');
        expect(house.buildingSegments).toHaveLength(2);
        expect((house.buildingOpenings as unknown[]).some((opening) => (opening as { type: string }).type === 'door')).toBe(true);
        expect((house.buildingOpenings as unknown[]).filter((opening) => (opening as { type: string }).type === 'window').length).toBeGreaterThan(0);
    });

    it('creates current-format T and cross intersections', () => {
        const document = new ProjectDocument(emptyProject());
        const tId = document.addIntersection({ x: 4, y: 1, z: 8 }, {
            nodeCount: 3, width: 10, length: 8, rotation: 90, sidewalk: true,
            roadTexture: 'road.png', sidewalkTexture: 'sidewalk.png',
        });
        const crossId = document.addIntersection({ x: 20, y: 0, z: 0 }, { nodeCount: 4 });

        expect(document.get(tId)).toMatchObject({
            type: 'intersection', nodes: [{ x: 4, y: 1, z: 8 }], nodeCount: 3,
            width: 10, length: 8, rotation: 90, edgeType: 'sidewalk',
            textures: { road: 'road.png', sidewalk: 'sidewalk.png' },
        });
        expect(document.get(crossId)).toMatchObject({ nodeCount: 4, width: 8, length: 8 });
        const [roadId] = document.addRoadPath([
            { x: 10, y: 1, z: 8 }, { x: 20, y: 1, z: 8 },
        ]);
        document.connect(tId, 1, roadId, 0);
        expect(document.data.connections).toContainEqual({ elementA: tId, nodeA: 1, elementB: roadId, nodeB: 0 });
        expect(document.summary().elements.find((element) => element.id === tId)?.nodeCount).toBe(3);
    });

    it('clamps road divisions to the low-poly project limit', () => {
        const document = new ProjectDocument(emptyProject());
        const [id] = document.addRoadPath([
            { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
        ], { divisions: 99 });

        expect(document.get(id).divisions).toBe(4);
    });

    it('generates a village entirely from native editable elements', () => {
        const document = new ProjectDocument(emptyProject());
        const result = createPolishVillage(document, { houseCount: 6, seed: 7 });
        const summary = document.summary();

        expect(result.houseCount).toBe(6);
        expect(summary.counts.building).toBe(6);
        expect(summary.counts.road).toBe(1);
        expect(summary.counts.fence).toBeGreaterThan(12);
        expect(summary.foliageInstances).toBe(54);
    });
});
