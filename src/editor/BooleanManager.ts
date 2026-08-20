import * as THREE from 'three';
import * as polygonClipping from 'polygon-clipping';
import { singleton } from 'tsyringe';
import type WorldElement from '../elements/WorldElement';
import Terrain from '../elements/Terrain.ts';
import type { OccupiedTriangle } from '../elements/WorldElement';

type MultiPolygon = number[][][][];

@singleton()
export default class BooleanManager {
    private static readonly SNAP = 1e6;
    private static readonly MIN_AREA = 1e-8;
    private static readonly CONTAIN_EPSILON = 1e-5;

    public cutTerrainSurface(terrain: Terrain, elements: WorldElement[]): OccupiedTriangle[] {
        const terrainOccupied = terrain.getOccupiedArea();
        const terrainBounds = this.getBounds(terrainOccupied);
        const cutAreas = this.collectTerrainCutAreas(terrain, elements, terrainBounds);

        return this.cutOccupiedSurface(terrainOccupied, cutAreas);
    }

    public cutOccupiedSurface(surface: OccupiedTriangle[], cutAreas: OccupiedTriangle[]): OccupiedTriangle[] {
        const surfaceArea = this.toMultiPolygon(surface);
        if (surfaceArea.length === 0) return [];

        if (cutAreas.length === 0) {
            return this.triangulateMultiPolygon(surfaceArea, surface);
        }

        const cutters = this.toMultiPolygon(cutAreas);
        if (cutters.length === 0) {
            return this.triangulateMultiPolygon(surfaceArea, surface);
        }

        try {
            const difference = (polygonClipping as any).difference(surfaceArea, cutters) as MultiPolygon | null;
            return this.triangulateMultiPolygon(difference ?? [], [...cutAreas, ...surface]);
        } catch {
            // Fallback: keep terrain intact instead of crashing boolean operations.
            return this.triangulateMultiPolygon(surfaceArea, surface);
        }
    }

    public getTerrainCutAreas(terrain: Terrain, elements: WorldElement[]): OccupiedTriangle[] {
        const terrainBounds = this.getBounds(terrain.getOccupiedArea());
        return this.collectTerrainCutAreas(terrain, elements, terrainBounds);
    }

    private collectTerrainCutAreas(
        terrain: Terrain,
        elements: WorldElement[],
        terrainBounds: { minX: number; minZ: number; maxX: number; maxZ: number },
    ): OccupiedTriangle[] {
        const cutAreas: OccupiedTriangle[] = [];
        for (const element of elements) {
            if (element === terrain) continue;
            if (element.constructor.name === 'Terrain') continue;
            if (!element.cutsTerrainSurface()) continue;
            const occupied = element.getOccupiedArea();
            if (occupied.length === 0) continue;
            if (!this.boundsOverlap(terrainBounds, this.getBounds(occupied))) continue;
            cutAreas.push(...occupied);
        }
        return cutAreas;
    }

    private toMultiPolygon(triangles: OccupiedTriangle[]): MultiPolygon {
        const polygons: MultiPolygon[] = [];
        for (const tri of triangles) {
            const a = this.snapPoint(tri.a.x, tri.a.z);
            const b = this.snapPoint(tri.b.x, tri.b.z);
            const c = this.snapPoint(tri.c.x, tri.c.z);
            if (this.triangleArea(a, b, c) < BooleanManager.MIN_AREA) continue;

            const polygon: MultiPolygon = [[[
                a,
                b,
                c,
                a,
            ]]];
            polygons.push(polygon);
        }

        if (polygons.length === 0) return [];

        let result = polygons[0];
        const chunkSize = 32;

        for (let i = 1; i < polygons.length; i += chunkSize) {
            const chunk = polygons.slice(i, i + chunkSize);
            try {
                result = ((polygonClipping as any).union(result, ...chunk) as MultiPolygon | null) ?? result;
            } catch {
                // Fallback: attempt one-by-one and ignore pathological sliver polygons.
                for (const poly of chunk) {
                    try {
                        result = ((polygonClipping as any).union(result, poly) as MultiPolygon | null) ?? result;
                    } catch {
                        // Ignore invalid polygon fragments.
                    }
                }
            }
        }

        return result;
    }

    private snapPoint(x: number, y: number): [number, number] {
        const s = BooleanManager.SNAP;
        return [Math.round(x * s) / s, Math.round(y * s) / s];
    }

    private triangleArea(a: [number, number], b: [number, number], c: [number, number]): number {
        return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5;
    }

    private triangulateMultiPolygon(multi: MultiPolygon, sourceTriangles: OccupiedTriangle[]): OccupiedTriangle[] {
        const result: OccupiedTriangle[] = [];
        for (const polygon of multi) {
            if (polygon.length === 0) continue;

            const contour = this.toRing(polygon[0]);
            if (contour.length < 3) continue;

            const holes = polygon.slice(1).map((ring) => this.toRing(ring)).filter((ring) => ring.length >= 3);
            const triangles = THREE.ShapeUtils.triangulateShape(contour, holes);
            const points = [...contour, ...holes.flat()];

            for (const [a, b, c] of triangles) {
                const pa = points[a];
                const pb = points[b];
                const pc = points[c];
                result.push({
                    a: this.restorePoint3D(pa, sourceTriangles),
                    b: this.restorePoint3D(pb, sourceTriangles),
                    c: this.restorePoint3D(pc, sourceTriangles),
                });
            }
        }
        return result;
    }

    private toRing(ring: number[][]): THREE.Vector2[] {
        if (ring.length === 0) return [];
        const out: THREE.Vector2[] = [];
        for (let i = 0; i < ring.length; i++) {
            const pt = ring[i];
            if (i === ring.length - 1 && pt[0] === ring[0][0] && pt[1] === ring[0][1]) {
                continue;
            }
            out.push(new THREE.Vector2(pt[0], pt[1]));
        }
        return out;
    }

    private restorePoint3D(point: THREE.Vector2, sourceTriangles: OccupiedTriangle[]): THREE.Vector3 {
        for (const tri of sourceTriangles) {
            const barycentric = this.getBarycentricXZ(point, tri);
            if (!barycentric) continue;

            const { u, v, w } = barycentric;
            const y = tri.a.y * u + tri.b.y * v + tri.c.y * w;
            return new THREE.Vector3(point.x, y, point.y);
        }

        return new THREE.Vector3(point.x, 0, point.y);
    }

    private getBarycentricXZ(
        point: THREE.Vector2,
        tri: OccupiedTriangle,
    ): { u: number; v: number; w: number } | null {
        const ax = tri.a.x;
        const az = tri.a.z;
        const bx = tri.b.x;
        const bz = tri.b.z;
        const cx = tri.c.x;
        const cz = tri.c.z;

        const denominator = ((bz - cz) * (ax - cx)) + ((cx - bx) * (az - cz));
        if (Math.abs(denominator) < BooleanManager.MIN_AREA) return null;

        const u = (((bz - cz) * (point.x - cx)) + ((cx - bx) * (point.y - cz))) / denominator;
        const v = (((cz - az) * (point.x - cx)) + ((ax - cx) * (point.y - cz))) / denominator;
        const w = 1 - u - v;
        const epsilon = BooleanManager.CONTAIN_EPSILON;

        if (u < -epsilon || v < -epsilon || w < -epsilon) return null;
        if (u > 1 + epsilon || v > 1 + epsilon || w > 1 + epsilon) return null;

        return { u, v, w };
    }

    private getBounds(triangles: OccupiedTriangle[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
        let minX = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;

        for (const tri of triangles) {
            minX = Math.min(minX, tri.a.x, tri.b.x, tri.c.x);
            minZ = Math.min(minZ, tri.a.z, tri.b.z, tri.c.z);
            maxX = Math.max(maxX, tri.a.x, tri.b.x, tri.c.x);
            maxZ = Math.max(maxZ, tri.a.z, tri.b.z, tri.c.z);
        }

        return { minX, minZ, maxX, maxZ };
    }

    private boundsOverlap(
        a: { minX: number; minZ: number; maxX: number; maxZ: number },
        b: { minX: number; minZ: number; maxX: number; maxZ: number },
    ): boolean {
        return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
    }
}
