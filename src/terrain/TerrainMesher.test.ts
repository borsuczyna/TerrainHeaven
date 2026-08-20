import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import TerrainMesher, { type TerrainMesherInput } from './TerrainMesher';
import type { OccupiedTriangle } from '../elements/WorldElement';

const makeInput = (overrides: Partial<TerrainMesherInput> = {}): TerrainMesherInput => ({
    center: new THREE.Vector3(0, 0, 0),
    width: 30,
    length: 30,
    cutAreas: [],
    cutPoints: [],
    settings: {
        meshDetail: 2,
        triangleLimit: 400,
        smoothingEnabled: true,
        smoothingRadius: 4,
        maxSlopeDegrees: 35,
    },
    ...overrides,
});

const rectangleCut = (minX: number, maxX: number, minZ: number, maxZ: number, y: number): OccupiedTriangle[] => {
    const bl = new THREE.Vector3(minX, y, minZ);
    const br = new THREE.Vector3(maxX, y, minZ);
    const tr = new THREE.Vector3(maxX, y, maxZ);
    const tl = new THREE.Vector3(minX, y, maxZ);
    return [
        { a: bl, b: br, c: tr },
        { a: bl.clone(), b: tr.clone(), c: tl },
    ];
};

const signedArea = (tri: OccupiedTriangle): number => (
    (tri.b.x - tri.a.x) * (tri.c.z - tri.a.z)
    - (tri.b.z - tri.a.z) * (tri.c.x - tri.a.x)
);

const topologyKey = (triangles: OccupiedTriangle[]): string[] => triangles.map((tri) => (
    [tri.a, tri.b, tri.c]
        .map((point) => `${point.x.toFixed(5)},${point.z.toFixed(5)}`)
        .sort()
        .join('|')
)).sort();

describe('TerrainMesher geometry invariants', () => {
    it('keeps an unconstrained flat terrain minimal', () => {
        const triangles = new TerrainMesher().build(makeInput());
        expect(triangles).toHaveLength(2);
        expect(triangles.every((tri) => Math.abs(signedArea(tri)) > 1e-8)).toBe(true);
    });

    it('preserves a road hole and its exact boundary height', () => {
        const cutAreas = rectangleCut(-2, 2, -10, 10, 0.5);
        const triangles = new TerrainMesher().build(makeInput({ cutAreas }));

        for (const tri of triangles) {
            const x = (tri.a.x + tri.b.x + tri.c.x) / 3;
            const z = (tri.a.z + tri.b.z + tri.c.z) / 3;
            expect(x > -2 && x < 2 && z > -10 && z < 10).toBe(false);
            expect(Math.abs(signedArea(tri))).toBeGreaterThan(1e-8);
        }

        const boundaryVertices = triangles.flatMap((tri) => [tri.a, tri.b, tri.c])
            .filter((point) => Math.abs(Math.abs(point.x) - 2) < 1e-5 && point.z >= -10 && point.z <= 10);
        expect(boundaryVertices.length).toBeGreaterThan(0);
        expect(boundaryVertices.every((point) => Math.abs(point.y - 0.5) < 1e-5)).toBe(true);
    });

    it('keeps a terrain cut point exact and respects the triangle budget', () => {
        const cutPoint = new THREE.Vector3(1.25, 6, -0.75);
        const input = makeInput({ cutPoints: [cutPoint] });
        const triangles = new TerrainMesher().build(input);
        const matching = triangles.flatMap((tri) => [tri.a, tri.b, tri.c]).filter((point) => (
            Math.abs(point.x - cutPoint.x) < 1e-5 && Math.abs(point.z - cutPoint.z) < 1e-5
        ));

        expect(matching.length).toBeGreaterThan(0);
        expect(matching.every((point) => Math.abs(point.y - cutPoint.y) < 1e-5)).toBe(true);
        expect(triangles.length).toBeLessThanOrEqual(input.settings.triangleLimit);
    });

    it('reuses the same XZ topology when only a cut point height changes', () => {
        const mesher = new TerrainMesher();
        const low = mesher.build(makeInput({ cutPoints: [new THREE.Vector3(0, 2, 0)] }));
        const high = mesher.build(makeInput({ cutPoints: [new THREE.Vector3(0, 8, 0)] }));

        expect(topologyKey(high)).toEqual(topologyKey(low));
        expect(high.some((tri) => [tri.a, tri.b, tri.c].some((point) => point.x === 0 && point.z === 0 && point.y === 8))).toBe(true);
    });

    it('does not create non-manifold interior edges', () => {
        const triangles = new TerrainMesher().build(makeInput({
            cutAreas: rectangleCut(-3, 3, -8, 8, -1),
            cutPoints: [new THREE.Vector3(-8, 4, 0), new THREE.Vector3(8, -3, 0)],
        }));
        const edges = new Map<string, number>();
        const key = (a: THREE.Vector3, b: THREE.Vector3): string => {
            const ka = `${a.x.toFixed(5)},${a.z.toFixed(5)}`;
            const kb = `${b.x.toFixed(5)},${b.z.toFixed(5)}`;
            return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        };
        for (const tri of triangles) {
            for (const [a, b] of [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]]) {
                const edge = key(a, b);
                edges.set(edge, (edges.get(edge) ?? 0) + 1);
            }
        }
        expect([...edges.values()].every((count) => count === 1 || count === 2)).toBe(true);
    });
});
