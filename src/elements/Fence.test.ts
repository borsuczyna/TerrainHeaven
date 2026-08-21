import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Fence from './Fence';
import type { GeometryGroup } from './WorldElement';

class TestFence extends Fence {
    public geometryGroups(): GeometryGroup[] { return this.getGeometry(); }
}

describe('Fence', () => {
    it('builds a two-sided panel and evenly spaced posts including both ends', () => {
        const fence = new Fence(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
        fence.postSpacing = 2;
        fence.update();

        const posts = fence.getPostPositions();
        expect(posts).toHaveLength(6);
        expect(posts[0].x).toBeCloseTo(0);
        expect(posts.at(-1)?.x).toBeCloseTo(10);

        const panelGroup = fence.getGroupNames().indexOf('fence');
        const material = (fence.mesh.material as THREE.MeshStandardMaterial[])[panelGroup];
        expect(material.side).toBe(THREE.DoubleSide);
        expect(fence.mesh.geometry.groups[panelGroup].count).toBe(6);
    });

    it('adds posts as accumulated curve turn reaches Max Angle Step', () => {
        const fence = new Fence(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
        fence.divisions = 24;
        fence.setCurvePointA(new THREE.Vector3(0, 0, 8));
        fence.setCurvePointB(new THREE.Vector3(10, 0, 8));
        fence.postSpacing = 100;
        fence.maxAngleStep = 20;

        expect(fence.getPostPositions().length).toBeGreaterThan(2);
    });

    it('round-trips style, curve and circular post settings', () => {
        const fence = new Fence(new THREE.Vector3(1, 2, 3), new THREE.Vector3(9, 2, 5));
        fence.style = 'box';
        fence.divisions = 8;
        fence.setCurvePointA(new THREE.Vector3(3, 2, 8));
        fence.postShape = 'circle';
        fence.postSides = 18;
        fence.postHeight = 2.4;

        const restored = Fence.deserialize(fence.serialize(4));
        expect(restored.style).toBe('box');
        expect(restored.divisions).toBe(8);
        expect(restored.postShape).toBe('circle');
        expect(restored.postSides).toBe(18);
        expect(restored.postHeight).toBeCloseTo(2.4);
        expect(restored.serialize(4).curvePointA).toEqual({ x: 3, y: 2, z: 8 });
    });

    it('winds post sides and caps outward', () => {
        const fence = new TestFence(new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 0, 0));
        fence.postSpacing = 10;
        fence.postShape = 'circle';
        fence.postSides = 8;
        const triangles = fence.geometryGroups().find((group) => group.name === 'posts')!.triangles;

        const side = triangles[0];
        const sideNormal = side.b.clone().sub(side.a).cross(side.c.clone().sub(side.a)).normalize();
        const sideCenter = side.a.clone().add(side.b).add(side.c).multiplyScalar(1 / 3);
        expect(new THREE.Vector2(sideNormal.x, sideNormal.z).dot(new THREE.Vector2(sideCenter.x, sideCenter.z))).toBeGreaterThan(0);

        const top = triangles[2];
        const topNormal = top.b.clone().sub(top.a).cross(top.c.clone().sub(top.a)).normalize();
        const bottom = triangles[3];
        const bottomNormal = bottom.b.clone().sub(bottom.a).cross(bottom.c.clone().sub(bottom.a)).normalize();
        expect(topNormal.y).toBeGreaterThan(0.99);
        expect(bottomNormal.y).toBeLessThan(-0.99);
    });

    it.each(['plane', 'box'] as const)('fits %s panel height into UV V 0..1', (style) => {
        const fence = new TestFence(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6, 0, 0));
        fence.style = style;
        fence.height = 3.75;
        const triangles = fence.geometryGroups().find((group) => group.name === 'fence')!.triangles;
        const v = triangles.flatMap((triangle) => [triangle.uvA.y, triangle.uvB.y, triangle.uvC.y]);
        expect(Math.min(...v)).toBe(0);
        expect(Math.max(...v)).toBe(1);
    });

    it('exposes Texture Stretch in the inspector and applies it to fence UVs', () => {
        const fence = new TestFence(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6, 0, 0));
        const property = fence.getProperties().sections
            .flatMap((section) => section.properties)
            .find((candidate) => candidate.label === 'Texture Stretch');
        expect(property?.type).toBe('number');
        if (property?.type !== 'number') throw new Error('Texture Stretch property is missing');
        property.set(0.5);

        const triangles = fence.geometryGroups().find((group) => group.name === 'fence')!.triangles;
        const u = triangles.flatMap((triangle) => [triangle.uvA.x, triangle.uvB.x, triangle.uvC.x]);
        expect(Math.min(...u)).toBe(0);
        expect(Math.max(...u)).toBeCloseTo(3);
    });

    it('winds every box panel face outward', () => {
        const fence = new TestFence(new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 0, 0));
        fence.style = 'box';
        fence.height = 2;
        fence.thickness = 0.4;
        const triangles = fence.geometryGroups().find((group) => group.name === 'fence')!.triangles;
        const boxCenter = new THREE.Vector3(2, 1, 0);

        for (let index = 0; index < triangles.length; index += 2) {
            const triangle = triangles[index];
            const normal = triangle.b.clone().sub(triangle.a).cross(triangle.c.clone().sub(triangle.a)).normalize();
            const faceCenter = triangle.a.clone().add(triangle.b).add(triangle.c)
                .add(triangles[index + 1].c).multiplyScalar(0.25);
            expect(normal.dot(faceCenter.sub(boxCenter))).toBeGreaterThan(0);
        }
    });

    it('adds reverse plane triangles only to exported geometry', () => {
        const fence = new TestFence(new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 0, 0));
        const editorTriangles = fence.geometryGroups().find((group) => group.name === 'fence')!.triangles;
        const exportedTriangles = fence.getExportGeometry(0).find((group) => group.name === 'fence')!.triangles;
        expect(editorTriangles).toHaveLength(2);
        expect(exportedTriangles).toHaveLength(4);
    });

    it('keeps both triangles aligned when Texture Stretch is not 1', () => {
        const fence = new TestFence(new THREE.Vector3(0, 0, 0), new THREE.Vector3(8, 0, 0));
        fence.setUVTransform('fence', { offsetX: 0, offsetY: 0, scaleX: 1.7, scaleY: 1 });
        const triangles = fence.geometryGroups().find((group) => group.name === 'fence')!.triangles;
        expect(triangles).toHaveLength(2);
        expect(triangles[0].uvA.x).toBeCloseTo(triangles[1].uvA.x, 8);
        expect(triangles[0].uvC.x).toBeCloseTo(triangles[1].uvB.x, 8);
        expect(triangles[0].uvC.y).toBeCloseTo(triangles[1].uvB.y, 8);
        expect(triangles[0].uvC.x).toBeCloseTo(13.6, 8);
    });
});
