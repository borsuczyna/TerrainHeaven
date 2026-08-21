import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Road from './Road';
import type { GeometryGroup } from './WorldElement';

class TestRoad extends Road {
    public geometryGroups(): GeometryGroup[] {
        return this.getGeometry();
    }
}

describe('Road UV mapping', () => {
    it('keeps the longitudinal UV constant across every curved-road section', () => {
        const road = new TestRoad(new THREE.Vector3(-8, 0, 0), new THREE.Vector3(8, 0, 0));
        road.lanes = 1;
        road.width = 6;
        road.divisions = 12;
        road.setCurvePointA(new THREE.Vector3(-5, 0, 10));
        road.setCurvePointB(new THREE.Vector3(5, 0, 10));

        const triangles = road.geometryGroups().find((group) => group.name === 'road')?.triangles ?? [];
        expect(triangles.length).toBeGreaterThan(4);

        for (let index = 0; index < triangles.length; index += 2) {
            const first = triangles[index];
            const second = triangles[index + 1];
            expect(first.uvA.y).toBeCloseTo(first.uvB.y, 8);
            expect(second.uvA.y).toBeCloseTo(first.uvA.y, 8);
            expect(second.uvB.y).toBeCloseTo(second.uvC.y, 8);
        }
    });
});

describe('Road crown', () => {
    it('creates an exact centre ridge independently of lane count', () => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
        road.lanes = 1;
        road.roadCrown = 0.6;

        const triangles = road.geometryGroups().find((group) => group.name === 'road')?.triangles ?? [];
        const heights = triangles.flatMap((triangle) => [triangle.a.y, triangle.b.y, triangle.c.y]);

        expect(Math.max(...heights)).toBeCloseTo(0.6, 8);
        expect(heights.some((height) => Math.abs(height) < 1e-8)).toBe(true);
    });

    it('keeps a midpoint section when connected endpoint crowns differ', () => {
        const road = new TestRoad(new THREE.Vector3(-10, 0, 0), new THREE.Vector3(0, 0, 0));
        const neighbour = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
        road.lanes = 1;
        neighbour.lanes = 1;
        road.roadCrown = 1;
        neighbour.roadCrown = 0;
        road.connectWith(1, neighbour, 0);

        const triangles = road.geometryGroups().find((group) => group.name === 'road')?.triangles ?? [];
        const centreVertices = triangles.flatMap((triangle) => [triangle.a, triangle.b, triangle.c])
            .filter((vertex) => Math.abs(vertex.z) < 1e-8);

        expect(centreVertices.some((vertex) => Math.abs(vertex.x + 5) < 1e-8 && Math.abs(vertex.y - 1) < 1e-8)).toBe(true);
        expect(centreVertices.some((vertex) => Math.abs(vertex.x) < 1e-8 && Math.abs(vertex.y - 0.5) < 1e-8)).toBe(true);
    });
});

describe('Road bridge edges', () => {
    it.each([
        ['solid', 24],
        ['plane', 8],
        ['spaced', 1],
        ['truss', 1],
    ] as const)('builds the %s bridge edge variant', (style, minimumTriangleCount) => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = style;
        road.bridgeEdgeDistance = 3;
        road.bridgeEdgeLength = 1;

        const triangles = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles ?? [];
        expect(triangles.length).toBeGreaterThanOrEqual(minimumTriangleCount);
        expect(road.getUVGroups()).toContain('bridgeEdges');
    });

    it('round-trips bridge edge settings through project data', () => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = 'spaced';
        road.bridgeEdgeHeight = 1.2;
        road.bridgeEdgeWidth = 0.35;
        road.bridgeEdgeDistance = 4;
        road.bridgeEdgeLength = 1.5;
        road.bridgeEdgeCapEnabled = true;
        road.bridgeEdgeCapHeight = 0.18;
        road.bridgeEdgeCapWidth = 0.44;
        road.bridgeEdgeCapJoined = true;

        const restored = Road.deserialize(road.serialize(1));
        expect(restored.edgeType).toBe('bridge');
        expect(restored.bridgeEdgeStyle).toBe('spaced');
        expect(restored.bridgeEdgeHeight).toBe(1.2);
        expect(restored.bridgeEdgeWidth).toBe(0.35);
        expect(restored.bridgeEdgeDistance).toBe(4);
        expect(restored.bridgeEdgeLength).toBe(1.5);
        expect(restored.bridgeEdgeCapEnabled).toBe(true);
        expect(restored.bridgeEdgeCapHeight).toBe(0.18);
        expect(restored.bridgeEdgeCapWidth).toBe(0.44);
        expect(restored.bridgeEdgeCapJoined).toBe(true);
    });

    it.each(['solid', 'spaced'] as const)('closes %s walls at the bridge deck underside', (style) => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = style;
        road.bridgeDeckThickness = 0.7;

        const triangles = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles ?? [];
        const vertices = triangles.flatMap((triangle) => [triangle.a, triangle.b, triangle.c]);
        const bottomTriangles = triangles.filter((triangle) =>
            Math.abs(triangle.a.y + 0.7) < 1e-8
            && Math.abs(triangle.b.y + 0.7) < 1e-8
            && Math.abs(triangle.c.y + 0.7) < 1e-8);

        expect(Math.min(...vertices.map((vertex) => vertex.y))).toBeCloseTo(-0.7, 8);
        expect(bottomTriangles.length).toBeGreaterThan(0);
    });

    it('uses outward winding for spaced walls on both road sides', () => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        road.width = 4;
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = 'spaced';
        road.bridgeEdgeWidth = 0.25;

        const triangles = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles ?? [];
        const normalOf = (triangle: (typeof triangles)[number]): THREE.Vector3 => new THREE.Vector3()
            .subVectors(triangle.b, triangle.a)
            .cross(new THREE.Vector3().subVectors(triangle.c, triangle.a))
            .normalize();
        const centroidZ = (triangle: (typeof triangles)[number]): number =>
            (triangle.a.z + triangle.b.z + triangle.c.z) / 3;
        const sideFaces = triangles.filter((triangle) => Math.abs(normalOf(triangle).z) > 0.9);

        for (const triangle of sideFaces) {
            const normal = normalOf(triangle);
            const z = centroidZ(triangle);
            const isOuterFace = Math.abs(z) > road.width * 0.5 + road.bridgeEdgeWidth * 0.5;
            const expectedSign = isOuterFace ? Math.sign(z) : -Math.sign(z);
            expect(Math.sign(normal.z)).toBe(expectedSign);
        }
    });

    it('does not mirror bridge edge walls into the bridge deck shell', () => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        road.lanes = 1;
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = 'solid';
        road.bridgeEdgeHeight = 1;
        road.bridgeDeckThickness = 0.4;
        road.bridgeEnabled = true;

        const deckTriangles = road.geometryGroups().find((group) => group.name === 'bridgeDeck')?.triangles ?? [];
        const deckVertices = deckTriangles.flatMap((triangle) => [triangle.a, triangle.b, triangle.c]);

        expect(deckVertices.length).toBeGreaterThan(0);
        expect(Math.max(...deckVertices.map((vertex) => vertex.y))).toBeLessThanOrEqual(1e-8);
    });

    it('renders plane bridge edges double-sided without coplanar duplicate faces', () => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = 'plane';
        const triangles = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles ?? [];

        road.update();
        const materialIndex = road.getGroupNames().indexOf('bridgeEdges');
        const materials = road.mesh.material as THREE.MeshStandardMaterial[];

        expect(triangles).toHaveLength(8);
        expect(materials[materialIndex].side).toBe(THREE.DoubleSide);
    });

    it('closes both solid walls at the beginning and end of the road', () => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = 'solid';

        const triangles = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles ?? [];
        const endCaps = triangles.filter((triangle) => {
            const xs = [triangle.a.x, triangle.b.x, triangle.c.x];
            return xs.every((x) => Math.abs(x) < 1e-8)
                || xs.every((x) => Math.abs(x - 12) < 1e-8);
        });

        expect(endCaps).toHaveLength(8);
    });

    it('does not insert solid-wall end caps between compatible connected roads', () => {
        const first = new TestRoad(new THREE.Vector3(-10, 0, 0), new THREE.Vector3(0, 0, 0));
        const second = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
        first.edgeType = 'bridge';
        second.edgeType = 'bridge';
        first.bridgeEdgeStyle = 'solid';
        second.bridgeEdgeStyle = 'solid';
        first.connectWith(1, second, 0);

        for (const road of [first, second]) {
            const triangles = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles ?? [];
            const sharedEndCaps = triangles.filter((triangle) =>
                [triangle.a.x, triangle.b.x, triangle.c.x].every((x) => Math.abs(x) < 1e-8));
            expect(sharedEndCaps).toHaveLength(0);
        }
    });

    it('adds a closed box cap only to spaced walls', () => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = 'spaced';
        road.bridgeEdgeHeight = 0.8;
        road.bridgeEdgeCapHeight = 0.2;
        const withoutCap = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles.length ?? 0;

        road.bridgeEdgeCapEnabled = true;
        const capTriangles = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles ?? [];
        const topFaces = capTriangles.filter((triangle) =>
            Math.abs(triangle.a.y - 1) < 1e-8
            && Math.abs(triangle.b.y - 1) < 1e-8
            && Math.abs(triangle.c.y - 1) < 1e-8);

        expect(capTriangles.length).toBeGreaterThan(withoutCap);
        expect(topFaces.length).toBeGreaterThan(0);
    });

    it('can join spaced wall caps into a continuous box along each road edge', () => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 0, 0));
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = 'spaced';
        road.bridgeEdgeLength = 1;
        road.bridgeEdgeCapEnabled = true;
        road.bridgeEdgeCapJoined = true;
        road.bridgeEdgeCapWidth = 0.5;
        road.bridgeEdgeCapHeight = 0.2;

        const triangles = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles ?? [];
        const joinedTopFaces = triangles.filter((triangle) => {
            const ys = [triangle.a.y, triangle.b.y, triangle.c.y];
            const xs = [triangle.a.x, triangle.b.x, triangle.c.x];
            return ys.every((y) => Math.abs(y - 1) < 1e-8)
                && Math.max(...xs) - Math.min(...xs) > road.bridgeEdgeLength;
        });

        expect(joinedTopFaces.length).toBeGreaterThan(0);
    });

    it('builds two raised steel trusses from closed beam boxes', () => {
        const road = new TestRoad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 0, 0));
        road.width = 5;
        road.edgeType = 'bridge';
        road.bridgeEdgeStyle = 'truss';
        road.bridgeEdgeHeight = 4;
        road.bridgeEdgeWidth = 0.2;
        road.bridgeEdgeDistance = 3;

        const triangles = road.geometryGroups().find((group) => group.name === 'bridgeEdges')?.triangles ?? [];
        const vertices = triangles.flatMap((triangle) => [triangle.a, triangle.b, triangle.c]);

        expect(triangles.length).toBeGreaterThan(200);
        expect(Math.max(...vertices.map((vertex) => vertex.y))).toBeGreaterThan(3.5);
        expect(vertices.some((vertex) => vertex.z > road.width * 0.5)).toBe(true);
        expect(vertices.some((vertex) => vertex.z < -road.width * 0.5)).toBe(true);
    });
});
