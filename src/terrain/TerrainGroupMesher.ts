import * as THREE from 'three';
import { inject, singleton } from 'tsyringe';
import SceneManager from '../editor/SceneManager';
import BooleanManager from '../editor/BooleanManager';
import TerrainCutPointManager from '../editor/TerrainCutPointManager';
import Terrain from '../elements/Terrain';
import TerrainCutSpline from '../elements/TerrainCutSpline';
import RiverSpline from '../elements/RiverSpline';
import type WorldElement from '../elements/WorldElement';
import type { OccupiedTriangle } from '../elements/WorldElement';
import TerrainMesher, {
    type TerrainCutPointInput,
    type TerrainMesherInput,
    type TerrainMesherSettings,
    type TerrainRect,
} from './TerrainMesher';

interface GroupCache {
    signature: string;
    slices: Map<Terrain, OccupiedTriangle[]>;
}

const EPSILON = 1e-5;

const boundsContain = (rect: TerrainRect, x: number, z: number): boolean => (
    x >= rect.minX - EPSILON && x <= rect.maxX + EPSILON
    && z >= rect.minZ - EPSILON && z <= rect.maxZ + EPSILON
);

const boundsDistance = (rect: TerrainRect, x: number, z: number): number => Math.hypot(
    x - THREE.MathUtils.clamp(x, rect.minX, rect.maxX),
    z - THREE.MathUtils.clamp(z, rect.minZ, rect.maxZ),
);

const occupiedBounds = (triangles: OccupiedTriangle[]): TerrainRect | null => {
    if (triangles.length === 0) return null;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const triangle of triangles) {
        for (const point of [triangle.a, triangle.b, triangle.c]) {
            minX = Math.min(minX, point.x);
            maxX = Math.max(maxX, point.x);
            minZ = Math.min(minZ, point.z);
            maxZ = Math.max(maxZ, point.z);
        }
    }
    return { minX, maxX, minZ, maxZ };
};

const rectsOverlap = (a: TerrainRect, b: TerrainRect, padding: number): boolean => (
    a.maxX + padding >= b.minX - EPSILON && a.minX - padding <= b.maxX + EPSILON
    && a.maxZ + padding >= b.minZ - EPSILON && a.minZ - padding <= b.maxZ + EPSILON
);

/**
 * Meshes a whole group of touching terrain tiles as one surface.
 *
 * Tiles used to be meshed one at a time and then reconciled along their shared edges,
 * which meant two neighbours each solved their own triangulation against their own copy
 * of the height field and the seam only looked right when those happened to agree. Here
 * the union of the group is triangulated once, every vertex height comes from a single
 * evaluation of a single field, and the resulting triangles are cut along the tile
 * borders afterwards so each tile still draws with its own texture. Matching is no
 * longer something to get right - there is nothing to match.
 */
@singleton()
export default class TerrainGroupMesher {
    private readonly meshers = new Map<Terrain, TerrainMesher>();
    private readonly caches = new Map<Terrain, GroupCache>();

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(BooleanManager) private readonly booleanManager: BooleanManager,
        @inject(TerrainCutPointManager) private readonly cutPointManager: TerrainCutPointManager,
    ) {}

    public getSurfaceFor(terrain: Terrain): OccupiedTriangle[] {
        const elements = this.scene.getElements();
        const terrains = elements.filter((element): element is Terrain => element instanceof Terrain);
        const groups = this.getGroups(terrains);
        const group = groups.find((members) => members.includes(terrain));
        if (!group) return [];

        const authority = group[0];
        this.pruneCaches(groups.map((members) => members[0]));

        const input = this.buildInput(group, terrains, elements);
        const signature = this.getSignature(group, input);
        const cached = this.caches.get(authority);
        if (cached?.signature === signature) return cached.slices.get(terrain) ?? [];

        let mesher = this.meshers.get(authority);
        if (!mesher) {
            mesher = new TerrainMesher();
            this.meshers.set(authority, mesher);
        }
        const slices = this.splitByTile(mesher.build(input), group);
        this.caches.set(authority, { signature, slices });
        return slices.get(terrain) ?? [];
    }

    public invalidate(): void {
        this.caches.clear();
        for (const mesher of this.meshers.values()) mesher.invalidate();
    }

    // Tiles that touch along an edge belong to one surface. Two tiles meeting only at a
    // corner count as well: their shared corner vertex still has to agree.
    private getGroups(terrains: Terrain[]): Terrain[][] {
        const groups: Terrain[][] = [];
        const remaining = new Set(terrains);
        for (const seed of terrains) {
            if (!remaining.delete(seed)) continue;
            const members = [seed];
            const queue = [seed];
            while (queue.length > 0) {
                const current = queue.shift()!;
                for (const candidate of terrains) {
                    if (!remaining.has(candidate)) continue;
                    if (!this.areNeighbours(current, candidate)) continue;
                    remaining.delete(candidate);
                    members.push(candidate);
                    queue.push(candidate);
                }
            }
            // Sorted so the group's identity and its base height never depend on the
            // order elements happen to sit in the scene.
            members.sort((a, b) => {
                const first = a.getBounds();
                const second = b.getBounds();
                return first.minX - second.minX || first.minZ - second.minZ;
            });
            groups.push(members);
        }
        return groups;
    }

    private areNeighbours(a: Terrain, b: Terrain): boolean {
        const first = a.getBounds();
        const second = b.getBounds();
        const overlapX = Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX);
        const overlapZ = Math.min(first.maxZ, second.maxZ) - Math.max(first.minZ, second.minZ);
        const touchesX = Math.abs(first.maxX - second.minX) <= EPSILON
            || Math.abs(first.minX - second.maxX) <= EPSILON;
        const touchesZ = Math.abs(first.maxZ - second.minZ) <= EPSILON
            || Math.abs(first.minZ - second.maxZ) <= EPSILON;
        // Overlapping tiles are one surface too, otherwise the overlap would be meshed
        // twice at two different heights.
        const overlaps = overlapX > EPSILON && overlapZ > EPSILON;
        return overlaps || (touchesX && overlapZ >= -EPSILON) || (touchesZ && overlapX >= -EPSILON);
    }

    // One surface needs one set of settings. Reducing them over the group means every
    // tile's value still counts for something - picking one tile as the authority left
    // the others' settings silently doing nothing.
    private getGroupSettings(group: Terrain[]): TerrainMesherSettings {
        return {
            meshDetail: Math.min(...group.map((tile) => tile.meshDetail)),
            triangleLimit: group.reduce((sum, tile) => sum + tile.triangleLimit, 0),
            smoothingEnabled: group.some((tile) => tile.smoothingEnabled),
            smoothingRadius: Math.max(...group.map((tile) => tile.smoothingRadius)),
            maxSlopeDegrees: Math.min(...group.map((tile) => tile.maxSlopeDegrees)),
        };
    }

    private buildInput(group: Terrain[], terrains: Terrain[], elements: WorldElement[]): TerrainMesherInput {
        const authority = group[0];
        const settings = this.getGroupSettings(group);
        const footprint = group.map((tile) => tile.getBounds());

        const cutAreas = new Map<string, OccupiedTriangle>();
        for (const tile of group) {
            for (const triangle of this.booleanManager.getTerrainCutAreas(tile, elements)) {
                cutAreas.set(this.triangleKey(triangle), triangle);
            }
        }

        const riverSurfaceHeights = new Map<RiverSpline, number>();
        for (const element of elements) {
            if (element instanceof RiverSpline) {
                riverSurfaceHeights.set(element, Terrain.getSharedRiverSurfaceHeight(element, terrains));
            }
        }

        const cutPoints: TerrainCutPointInput[] = [...this.cutPointManager.getPointsWithRadius()];
        for (const element of elements) {
            if (element instanceof TerrainCutSpline) cutPoints.push(...element.getSampledCutPoints());
            if (element instanceof RiverSpline) {
                cutPoints.push(...element.getSampledTerrainPoints(
                    riverSurfaceHeights.get(element) ?? authority.center.y,
                ));
            }
        }

        return {
            center: authority.center,
            baseHeight: authority.center.y,
            width: authority.width,
            length: authority.length,
            footprint,
            cutAreas: [...cutAreas.values()],
            influenceAreas: this.getInfluenceAreas(footprint, authority, settings, elements),
            cutPoints,
            paint: {
                cellSize: Terrain.PAINT_CELL_SIZE,
                samples: Terrain.collectPaintSamples(terrains, footprint),
            },
            settings,
        };
    }

    // An element shapes the surface as far as its slope needs to run back to the base
    // height. That reach is computed from the group's settings, so every tile in the
    // group agrees about which elements matter.
    private getInfluenceAreas(
        footprint: TerrainRect[],
        authority: Terrain,
        settings: TerrainMesherSettings,
        elements: WorldElement[],
    ): OccupiedTriangle[] {
        const maxSlope = Math.max(0.01, Math.tan(THREE.MathUtils.degToRad(
            THREE.MathUtils.clamp(settings.maxSlopeDegrees, 1, 89),
        )));
        const result: OccupiedTriangle[] = [];
        for (const element of elements) {
            if (element instanceof Terrain || !element.cutsTerrainSurface()) continue;
            const occupied = element.getOccupiedArea();
            const bounds = occupiedBounds(occupied);
            if (!bounds) continue;
            let heightDifference = 0;
            for (const triangle of occupied) {
                for (const point of [triangle.a, triangle.b, triangle.c]) {
                    heightDifference = Math.max(heightDifference, Math.abs(point.y - authority.center.y));
                }
            }
            const padding = Math.max(settings.smoothingRadius, 1.5 * heightDifference / maxSlope);
            if (footprint.some((rect) => rectsOverlap(bounds, rect, padding))) result.push(...occupied);
        }
        return result;
    }

    private triangleKey(triangle: OccupiedTriangle): string {
        return [triangle.a, triangle.b, triangle.c]
            .map((point) => `${point.x.toFixed(4)},${point.y.toFixed(4)},${point.z.toFixed(4)}`)
            .sort()
            .join('|');
    }

    private getSignature(group: Terrain[], input: TerrainMesherInput): string {
        const round = (value: number): string => value.toFixed(4);
        return [
            group.map((tile) => {
                const bounds = tile.getBounds();
                return [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].map(round).join(',');
            }).join(';'),
            round(input.baseHeight ?? 0),
            [
                input.settings.meshDetail,
                input.settings.triangleLimit,
                input.settings.smoothingEnabled ? 1 : 0,
                input.settings.smoothingRadius,
                input.settings.maxSlopeDegrees,
            ].join(','),
            input.cutAreas.map((triangle) => this.triangleKey(triangle)).sort().join('|'),
            (input.influenceAreas ?? []).map((triangle) => this.triangleKey(triangle)).sort().join('|'),
            input.cutPoints.map((point) => [
                round(point.position.x), round(point.position.y), round(point.position.z),
                round(point.radius),
                point.maxSlopeDegrees === undefined ? '-' : round(point.maxSlopeDegrees),
                round(point.slopeSmoothing ?? 0),
                point.profileOnly ? 1 : 0,
            ].join(',')).sort().join('|'),
            (input.paint?.samples ?? [])
                .map((sample) => `${sample.gridX},${sample.gridZ},${round(sample.height)}`)
                .sort()
                .join('|'),
        ].join('#');
    }

    private pruneCaches(authorities: Terrain[]): void {
        const live = new Set(authorities);
        for (const key of [...this.caches.keys()]) if (!live.has(key)) this.caches.delete(key);
        for (const key of [...this.meshers.keys()]) if (!live.has(key)) this.meshers.delete(key);
    }

    /**
     * Cuts the group surface along the tile borders and hands each tile its own share.
     * Splitting only adds vertices that already lie on the triangle being split, so the
     * surface itself is untouched - this is a bookkeeping step, not a geometry one.
     */
    private splitByTile(triangles: OccupiedTriangle[], group: Terrain[]): Map<Terrain, OccupiedTriangle[]> {
        const slices = new Map<Terrain, OccupiedTriangle[]>();
        for (const tile of group) slices.set(tile, []);
        if (group.length === 1) {
            slices.set(group[0], triangles);
            return slices;
        }

        const bounds = group.map((tile) => tile.getBounds());
        const xLines = this.interiorLines(bounds.map((rect) => rect.minX).concat(bounds.map((rect) => rect.maxX)));
        const zLines = this.interiorLines(bounds.map((rect) => rect.minZ).concat(bounds.map((rect) => rect.maxZ)));

        for (const triangle of triangles) {
            let polygons: THREE.Vector3[][] = [[triangle.a, triangle.b, triangle.c]];
            for (const [axis, lines] of [['x', xLines], ['z', zLines]] as ['x' | 'z', number[]][]) {
                for (const line of lines) {
                    const next: THREE.Vector3[][] = [];
                    for (const polygon of polygons) {
                        const values = polygon.map((point) => point[axis]);
                        if (Math.max(...values) <= line + EPSILON || Math.min(...values) >= line - EPSILON) {
                            next.push(polygon);
                            continue;
                        }
                        for (const half of [this.clip(polygon, axis, line, true), this.clip(polygon, axis, line, false)]) {
                            if (half.length >= 3) next.push(half);
                        }
                    }
                    polygons = next;
                }
            }

            for (const polygon of polygons) {
                const owner = this.findOwner(polygon, group, bounds);
                if (!owner) continue;
                const target = slices.get(owner)!;
                for (let index = 1; index + 1 < polygon.length; index++) {
                    const a = polygon[0];
                    const b = polygon[index];
                    const c = polygon[index + 1];
                    if (Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) <= 1e-9) continue;
                    target.push({ a: a.clone(), b: b.clone(), c: c.clone() });
                }
            }
        }
        return slices;
    }

    private interiorLines(values: number[]): number[] {
        const unique: number[] = [];
        for (const value of values.slice().sort((a, b) => a - b)) {
            if (unique.length === 0 || Math.abs(unique[unique.length - 1] - value) > EPSILON) unique.push(value);
        }
        // The outermost lines bound the whole group, so nothing crosses them.
        return unique.slice(1, -1);
    }

    private clip(polygon: THREE.Vector3[], axis: 'x' | 'z', line: number, keepBelow: boolean): THREE.Vector3[] {
        const inside = (point: THREE.Vector3): boolean => (
            keepBelow ? point[axis] <= line + EPSILON : point[axis] >= line - EPSILON
        );
        const result: THREE.Vector3[] = [];
        for (let index = 0; index < polygon.length; index++) {
            const a = polygon[index];
            const b = polygon[(index + 1) % polygon.length];
            const aInside = inside(a);
            if (aInside) result.push(a);
            if (aInside === inside(b)) continue;
            const span = b[axis] - a[axis];
            if (Math.abs(span) < 1e-12) continue;
            const t = THREE.MathUtils.clamp((line - a[axis]) / span, 0, 1);
            result.push(new THREE.Vector3().lerpVectors(a, b, t));
        }
        return result;
    }

    private findOwner(polygon: THREE.Vector3[], group: Terrain[], bounds: TerrainRect[]): Terrain | null {
        let x = 0;
        let z = 0;
        for (const point of polygon) {
            x += point.x;
            z += point.z;
        }
        x /= polygon.length;
        z /= polygon.length;

        for (let index = 0; index < group.length; index++) {
            if (boundsContain(bounds[index], x, z)) return group[index];
        }
        // Overlapping or floating-point-marginal pieces still have to belong somewhere,
        // otherwise the surface would develop holes.
        let best: Terrain | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < group.length; index++) {
            const distance = boundsDistance(bounds[index], x, z);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = group[index];
            }
        }
        return best;
    }
}
