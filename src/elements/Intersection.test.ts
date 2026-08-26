import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Intersection from './Intersection';
import Road from './Road';
import type { GeometryGroup } from './WorldElement';

class TestIntersection extends Intersection {
    public geometryGroups(): GeometryGroup[] { return this.getGeometry(); }
}

class TestRoad extends Road {
    public geometryGroups(): GeometryGroup[] { return this.getGeometry(); }
}

const roadVertices = (intersection: TestIntersection): THREE.Vector3[] =>
    (intersection.geometryGroups().find((group) => group.name === 'road')?.triangles ?? [])
        .flatMap((triangle) => [triangle.a, triangle.b, triangle.c]);

const geometrySnapshot = (intersection: TestIntersection): number[][] =>
    roadVertices(intersection).map((vertex) => [vertex.x, vertex.y, vertex.z]);

describe('Intersection fixed footprint', () => {
    it('offers only a 3-way T or a 4-way cross', () => {
        expect(new TestIntersection(new THREE.Vector3(), 2).nodeCount).toBe(3);
        expect(new TestIntersection(new THREE.Vector3(), 3).nodeCount).toBe(3);
        expect(new TestIntersection(new THREE.Vector3(), 4).nodeCount).toBe(4);
        expect(new TestIntersection(new THREE.Vector3(), 8).nodeCount).toBe(4);
    });

    it('builds three fixed outlet stubs for a T junction', () => {
        const intersection = new TestIntersection(new THREE.Vector3(), 3);
        const vertices = roadVertices(intersection);

        expect(Math.min(...vertices.map((vertex) => vertex.x))).toBeCloseTo(-6, 8);
        expect(Math.max(...vertices.map((vertex) => vertex.x))).toBeCloseTo(6, 8);
        expect(Math.min(...vertices.map((vertex) => vertex.z))).toBeCloseTo(-6, 8);
        expect(Math.max(...vertices.map((vertex) => vertex.z))).toBeCloseTo(2, 8);
        expect(intersection.getNode(0).mesh.position.toArray()).toEqual([-6, 0, 0]);
        expect(intersection.getNode(1).mesh.position.toArray()).toEqual([6, 0, 0]);
        expect(intersection.getNode(2).mesh.position.toArray()).toEqual([0, 0, -6]);
    });

    it('adds the fourth outlet for a crossroads', () => {
        const intersection = new TestIntersection(new THREE.Vector3(), 4);
        const vertices = roadVertices(intersection);

        expect(Math.max(...vertices.map((vertex) => vertex.z))).toBeCloseTo(6, 8);
        expect(intersection.getNode(3).mesh.position.toArray()).toEqual([0, 0, 6]);
        expect(vertices.every((vertex) =>
            Math.abs(vertex.x) <= 2 + 1e-8 || Math.abs(vertex.z) <= 2 + 1e-8)).toBe(true);
    });

    it('joins road sidewalks with clean L corners instead of stepped stub outlines', () => {
        const intersection = new TestIntersection(new THREE.Vector3(), 4);
        intersection.edgeType = 'sidewalk';
        intersection.sidewalkWidth = 1;
        intersection.curbHeight = 0.2;
        const triangles = intersection.geometryGroups()
            .find((group) => group.name === 'sidewalk')?.triangles ?? [];
        const topVertices = triangles.flatMap((triangle) => [triangle.a, triangle.b, triangle.c])
            .filter((vertex) => Math.abs(vertex.y - 0.2) < 1e-8);
        const hasPoint = (x: number, z: number): boolean => topVertices.some((vertex) =>
            Math.abs(vertex.x - x) < 1e-8 && Math.abs(vertex.z - z) < 1e-8);

        // North-west L: two straight road-side strips meeting at one mitred elbow.
        expect(hasPoint(-6, -2)).toBe(true);
        expect(hasPoint(-2, -2)).toBe(true);
        expect(hasPoint(-2, -6)).toBe(true);
        expect(hasPoint(-6, -3)).toBe(true);
        expect(hasPoint(-3, -3)).toBe(true);
        expect(hasPoint(-3, -6)).toBe(true);

        // The previous broken outline introduced extra bends at the central ±4 boundary.
        expect(topVertices.some((vertex) =>
            Math.abs(Math.abs(vertex.x) - 4) < 1e-8
            || Math.abs(Math.abs(vertex.z) - 4) < 1e-8)).toBe(false);
    });

    it('does not change the intersection mesh when a differently sized road connects', () => {
        const intersection = new TestIntersection(new THREE.Vector3(), 4);
        const before = geometrySnapshot(intersection);
        const road = new TestRoad(new THREE.Vector3(6, 0, 0), new THREE.Vector3(20, 0, 0));
        road.width = 10;

        road.connect(0, intersection, 1);

        expect(geometrySnapshot(intersection)).toEqual(before);
    });

    it('tapers a connected road to the outlet fixed width', () => {
        const intersection = new TestIntersection(new THREE.Vector3(), 4);
        intersection.outletWidth = 4;
        const road = new TestRoad(new THREE.Vector3(6, 0, 0), new THREE.Vector3(20, 0, 0));
        road.width = 10;
        road.connect(0, intersection, 1);

        const vertices = (road.geometryGroups().find((group) => group.name === 'road')?.triangles ?? [])
            .flatMap((triangle) => [triangle.a, triangle.b, triangle.c])
            .filter((vertex) => Math.abs(vertex.x - 6) < 1e-8);

        expect(Math.min(...vertices.map((vertex) => vertex.z))).toBeCloseTo(-2, 8);
        expect(Math.max(...vertices.map((vertex) => vertex.z))).toBeCloseTo(2, 8);
    });

    it('keeps an angled road endpoint flush with the intersection mouth', () => {
        const intersection = new TestIntersection(new THREE.Vector3(), 4);
        intersection.outletWidth = 4;
        const road = new TestRoad(new THREE.Vector3(6, 0, 0), new THREE.Vector3(20, 0, 5));
        road.width = 4;
        road.connect(0, intersection, 1);

        const endpointVertices = (road.geometryGroups().find((group) => group.name === 'road')?.triangles ?? [])
            .flatMap((triangle) => [triangle.a, triangle.b, triangle.c])
            .filter((vertex) => Math.abs(vertex.x - 6) < 1e-8);

        expect(endpointVertices.length).toBeGreaterThan(0);
        expect(Math.min(...endpointVertices.map((vertex) => vertex.z))).toBeCloseTo(-2, 8);
        expect(Math.max(...endpointVertices.map((vertex) => vertex.z))).toBeCloseTo(2, 8);
    });

    it('keeps a road ending at an intersection flush with the intersection mouth', () => {
        const intersection = new TestIntersection(new THREE.Vector3(), 4);
        intersection.outletWidth = 4;
        const road = new TestRoad(new THREE.Vector3(-20, 0, 5), new THREE.Vector3(-6, 0, 0));
        road.width = 4;
        road.connect(1, intersection, 0);

        const endpointVertices = (road.geometryGroups().find((group) => group.name === 'road')?.triangles ?? [])
            .flatMap((triangle) => [triangle.a, triangle.b, triangle.c])
            .filter((vertex) => Math.abs(vertex.x + 6) < 1e-8);

        expect(endpointVertices.length).toBeGreaterThan(0);
        expect(Math.min(...endpointVertices.map((vertex) => vertex.z))).toBeCloseTo(-2, 8);
        expect(Math.max(...endpointVertices.map((vertex) => vertex.z))).toBeCloseTo(2, 8);
    });

    it('round-trips the static outlet settings', () => {
        const intersection = new TestIntersection(new THREE.Vector3(2, 1, -3), 3);
        intersection.width = 11;
        intersection.length = 9;
        intersection.outletWidth = 3.5;
        intersection.outletLength = 2.75;
        intersection.rotation = 45;

        const restored = Intersection.deserialize(intersection.serialize(7));

        expect(restored.nodeCount).toBe(3);
        expect(restored.width).toBe(11);
        expect(restored.length).toBe(9);
        expect(restored.outletWidth).toBe(3.5);
        expect(restored.outletLength).toBe(2.75);
        expect(restored.rotation).toBe(45);
    });
});
