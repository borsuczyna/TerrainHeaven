import * as THREE from 'three';
import * as polygonClipping from 'polygon-clipping';
import { singleton } from 'tsyringe';
import type WorldElement from '../elements/WorldElement';
import Terrain from '../elements/Terrain.ts';
import type { OccupiedTriangle } from '../elements/WorldElement';

type MultiPolygon = number[][][][];

@singleton()
export default class BooleanManager {
    public cutTerrainSurface(terrain: Terrain, elements: WorldElement[]): OccupiedTriangle[] {
        const terrainOccupied = terrain.getOccupiedArea();
        const terrainArea = this.toMultiPolygon(terrainOccupied);
        if (terrainArea.length === 0) return [];
        const terrainBounds = this.getBounds(terrainOccupied);

        const cutAreas: OccupiedTriangle[] = [];
        for (const element of elements) {
            if (element === terrain) continue;
            if (element.constructor.name === 'Terrain') continue;
            const occupied = element.getOccupiedArea();
            if (occupied.length === 0) continue;
            if (!this.boundsOverlap(terrainBounds, this.getBounds(occupied))) continue;
            cutAreas.push(...occupied);
        }

        if (cutAreas.length === 0) {
            return this.triangulateMultiPolygon(terrainArea);
        }

        const cutters = this.toMultiPolygon(cutAreas);
        if (cutters.length === 0) {
            return this.triangulateMultiPolygon(terrainArea);
        }

        const difference = (polygonClipping as any).difference(terrainArea, cutters) as MultiPolygon | null;
        return this.triangulateMultiPolygon(difference ?? []);
    }

    private toMultiPolygon(triangles: OccupiedTriangle[]): MultiPolygon {
        let result: MultiPolygon = [];
        for (const tri of triangles) {
            const polygon: MultiPolygon = [[[
                [tri.a.x, tri.a.y],
                [tri.b.x, tri.b.y],
                [tri.c.x, tri.c.y],
                [tri.a.x, tri.a.y],
            ]]];
            if (result.length === 0) {
                result = polygon;
            } else {
                result = ((polygonClipping as any).union(result, polygon) as MultiPolygon | null) ?? result;
            }
        }
        return result;
    }

    private triangulateMultiPolygon(multi: MultiPolygon): OccupiedTriangle[] {
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
                result.push({ a: pa.clone(), b: pb.clone(), c: pc.clone() });
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

    private getBounds(triangles: OccupiedTriangle[]): { minX: number; minY: number; maxX: number; maxY: number } {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        for (const tri of triangles) {
            minX = Math.min(minX, tri.a.x, tri.b.x, tri.c.x);
            minY = Math.min(minY, tri.a.y, tri.b.y, tri.c.y);
            maxX = Math.max(maxX, tri.a.x, tri.b.x, tri.c.x);
            maxY = Math.max(maxY, tri.a.y, tri.b.y, tri.c.y);
        }

        return { minX, minY, maxX, maxY };
    }

    private boundsOverlap(
        a: { minX: number; minY: number; maxX: number; maxY: number },
        b: { minX: number; minY: number; maxX: number; maxY: number },
    ): boolean {
        return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
    }
}
